// =============================================================================
// 🎵 Music Quiz Game — Server Backend
// =============================================================================
// Server Node.js cho trò chơi đố nhạc nhiều người chơi thời gian thực.
// Sử dụng Express, Socket.IO, Multer và QRCode.
// =============================================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const QRCode = require('qrcode');

/**
 * Tìm địa chỉ IP nội bộ (LAN IPv4) tốt nhất của máy tính
 * Ưu tiên Wi-Fi hoặc Ethernet để điện thoại quét mã QR có thể truy cập được
 */
function getLanIpAddress() {
  const interfaces = os.networkInterfaces();
  const preferredNames = ['wi-fi', 'wifi', 'ethernet', 'eth', 'wlan', 'en0', 'en1', 'wlan0'];
  for (const pref of preferredNames) {
    for (const name of Object.keys(interfaces)) {
      if (name.toLowerCase().includes(pref)) {
        for (const iface of interfaces[name]) {
          if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
      }
    }
  }
  for (const name of Object.keys(interfaces)) {
    if (name.toLowerCase().includes('vpn') || name.toLowerCase().includes('radmin') || name.toLowerCase().includes('virtual')) continue;
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

// =============================================================================
// Khởi tạo ứng dụng
// =============================================================================

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 20 * 1024 * 1024, // 20MB cho Socket.IO
});

const PORT = process.env.PORT || 3000;

// Lưu trữ phòng chơi: Map(roomCode → roomObject)
const rooms = new Map();

// =============================================================================
// Cấu hình Multer — Upload file âm thanh
// =============================================================================

// Đảm bảo thư mục uploads tồn tại
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Cấu hình lưu trữ: tạo tên file duy nhất để tránh xung đột
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Tạo tên file duy nhất: timestamp + random + extension gốc
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  },
});

// Bộ lọc file: chấp nhận các định dạng âm thanh hợp lệ
const ALLOWED_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.webm', '.flac'];

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_EXTENSIONS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Định dạng file không được hỗ trợ: ${ext}. Chấp nhận: ${ALLOWED_EXTENSIONS.join(', ')}`), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 25 * 1024 * 1024 }, // Giới hạn 25MB mỗi file
});

// =============================================================================
// Phục vụ file tĩnh
// =============================================================================

// Phục vụ giao diện người dùng từ thư mục public/
app.use(express.static(path.join(__dirname, 'public')));

// Phục vụ file âm thanh đã upload
app.use('/uploads', express.static(uploadsDir));

// Middleware phân tích JSON
app.use(express.json());

// =============================================================================
// REST API Endpoints
// =============================================================================

/**
 * POST /api/upload
 * Upload 1 hoặc nhiều file âm thanh cùng lúc.
 * Chấp nhận: multipart/form-data với field 'audio' (single hoặc multiple) hoặc bất kỳ field nào.
 * Trả về: { fileName, originalName, url, files: [...] }
 */
app.post('/api/upload', (req, res) => {
  upload.any()(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File quá lớn. Giới hạn tối đa 25MB mỗi file.' });
      }
      return res.status(400).json({ error: `Lỗi upload: ${err.message}` });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }

    const files = req.files || (req.file ? [req.file] : []);
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'Không tìm thấy file âm thanh. Vui lòng chọn file để upload.' });
    }

    const processedFiles = files.map((file) => {
      // Sửa lỗi phông chữ / mojibake khi Multer giải mã header utf-8 theo chuẩn latin1
      let cleanOriginalName = file.originalname || '';
      try {
        let isAlreadyUnicode = false;
        for (let i = 0; i < cleanOriginalName.length; i++) {
          if (cleanOriginalName.charCodeAt(i) > 255) {
            isAlreadyUnicode = true;
            break;
          }
        }
        if (!isAlreadyUnicode) {
          const fixed = Buffer.from(cleanOriginalName, 'latin1').toString('utf8');
          if (fixed !== cleanOriginalName && !fixed.includes('\uFFFD')) {
            cleanOriginalName = fixed;
          }
        }
      } catch (e) {}

      return {
        fileName: file.filename,
        originalName: cleanOriginalName,
        url: `/uploads/${file.filename}`,
      };
    });

    // Trả về cả định dạng đơn (tương thích ngược) và mảng files
    res.json({
      success: true,
      count: processedFiles.length,
      fileName: processedFiles[0].fileName,
      originalName: processedFiles[0].originalName,
      url: processedFiles[0].url,
      files: processedFiles,
    });
  });
});

/**
 * GET /api/qrcode/:roomCode
 * Tạo mã QR cho URL tham gia phòng.
 * Trả về: { qrCode (data URL), url }
 */
app.get('/api/qrcode/:roomCode', async (req, res) => {
  try {
    const { roomCode } = req.params;

    // Xây dựng URL tham gia dựa trên request
    const protocol = req.protocol;
    let host = req.get('host') || `localhost:${PORT}`;

    // Nếu host là localhost hoặc 127.0.0.1, chuyển sang IP LAN Wi-Fi để điện thoại quét QR có thể truy cập được
    if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
      const lanIp = getLanIpAddress();
      if (lanIp && lanIp !== 'localhost') {
        host = host.replace(/^(localhost|127\.0\.0\.1)/, lanIp);
      }
    }

    const joinUrl = `${protocol}://${host}/?room=${roomCode}`;

    // Tạo QR code dạng data URL: mã đen trên nền trắng tương phản cao để quét dễ dàng
    const qrCodeDataUrl = await QRCode.toDataURL(joinUrl, {
      color: {
        dark: '#000000',  // Mã QR màu đen
        light: '#FFFFFF', // Nền màu trắng
      },
      width: 256,
      margin: 2,
    });

    res.json({
      qrCode: qrCodeDataUrl,
      url: joinUrl,
    });
  } catch (error) {
    console.error('Lỗi tạo QR code:', error);
    res.status(500).json({ error: 'Không thể tạo mã QR.' });
  }
});

/**
 * GET /api/youtube-info?url=...
 * Lấy tiêu đề và thông tin bài hát từ link YouTube qua oEmbed
 */
app.get('/api/youtube-info', async (req, res) => {
  try {
    let { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Thiếu tham số url.' });
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    // Gọi YouTube oEmbed
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const response = await fetch(oembedUrl);
    if (!response.ok) {
      return res.status(404).json({ error: 'Không tìm thấy video YouTube hoặc video bị chặn nhúng.' });
    }
    const data = await response.json();

    // Làm sạch tiêu đề (bỏ các hậu tố Official Music Video, MV, Lyric Video...)
    const cleanTitle = data.title
      .replace(/[\(\[\{](?:official\s*(?:music\s*)?video|mv|audio|lyric\s*video|visualizer|vietsub|karaoke|beat|remix|4k|hd|prod\.[^\)\]\}]+)[\)\]\}]/gi, '')
      .replace(/\|\s*official\s*(?:music\s*)?video/gi, '')
      .replace(/\|\s*mv/gi, '')
      .replace(/-\s*official\s*(?:music\s*)?video/gi, '')
      .trim()
      .replace(/\s+/g, ' ');

    res.json({
      success: true,
      title: cleanTitle || data.title,
      rawTitle: data.title,
      author: data.author_name,
      thumbnail: data.thumbnail_url
    });
  } catch (err) {
    console.error('Lỗi lấy thông tin YouTube:', err);
    res.status(500).json({ error: 'Không thể lấy thông tin video YouTube.' });
  }
});

// =============================================================================
// Hàm tiện ích
// =============================================================================

/**
 * Tạo mã phòng 6 ký tự ngẫu nhiên.
 * Chỉ dùng các ký tự dễ đọc (loại bỏ 0, O, 1, I để tránh nhầm lẫn).
 */
function generateRoomCode() {
  const EASY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += EASY_CHARS.charAt(Math.floor(Math.random() * EASY_CHARS.length));
    }
  } while (rooms.has(code)); // Đảm bảo mã phòng là duy nhất
  return code;
}

/**
 * Chuẩn hoá chuỗi để so sánh đáp án.
 * - Chuyển thành chữ thường
 * - Loại bỏ dấu (diacritics)
 * - Chỉ giữ ký tự chữ-số và khoảng trắng
 * - Cắt khoảng trắng thừa
 */
function normalizeString(str) {
  return str
    .toLowerCase()
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Loại bỏ combining characters (dấu)
    .replace(/[^a-z0-9\s]/g, '')     // Chỉ giữ chữ-số và khoảng trắng
    .trim()
    .replace(/\s+/g, ' ');           // Gộp khoảng trắng liên tiếp
}

/**
 * Tính khoảng cách Levenshtein giữa hai chuỗi.
 * Sử dụng giải thuật quy hoạch động (DP) chuẩn.
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;

  // Tạo ma trận (m+1) x (n+1)
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  // Khởi tạo hàng đầu và cột đầu
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  // Điền ma trận
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],     // Xoá
          dp[i][j - 1],     // Thêm
          dp[i - 1][j - 1]  // Thay thế
        );
      }
    }
  }

  return dp[m][n];
}

/**
 * So sánh đáp án (fuzzy matching).
 * Trả về true nếu đáp án của người chơi gần đúng với đáp án chính xác.
 *
 * Các tiêu chí:
 * 1. Khớp chính xác sau chuẩn hoá
 * 2. Chuỗi ngắn nằm trong chuỗi dài VÀ tỉ lệ độ dài >= 0.6
 * 3. Khoảng cách Levenshtein / độ dài tối đa <= 0.25
 */
function isAnswerCorrect(playerAnswer, correctAnswer) {
  if (!playerAnswer || !correctAnswer) return false;

  const normPlayer = normalizeString(playerAnswer);
  const normCorrect = normalizeString(correctAnswer);

  if (!normPlayer || !normCorrect) return false;

  // 1. Khớp chính xác sau khi chuẩn hóa chữ thường và bỏ dấu
  if (normPlayer === normCorrect) return true;

  // 2. KHÔNG TÍNH DẤU CÁCH: Bỏ toàn bộ khoảng trắng để so sánh
  const noSpacePlayer = normPlayer.replace(/\s+/g, '');
  const noSpaceCorrect = normCorrect.replace(/\s+/g, '');

  if (noSpacePlayer === noSpaceCorrect) return true;

  // 3. Kiểm tra bao hàm (không tính dấu cách)
  const shorter = noSpacePlayer.length <= noSpaceCorrect.length ? noSpacePlayer : noSpaceCorrect;
  const longer = noSpacePlayer.length > noSpaceCorrect.length ? noSpacePlayer : noSpaceCorrect;
  const ratio = shorter.length / longer.length;

  if (longer.includes(shorter) && ratio >= 0.7) return true;

  // 4. Khoảng cách Levenshtein (cho phép sai sót nhẹ 1-2 ký tự, không tính dấu cách)
  const maxLen = Math.max(noSpacePlayer.length, noSpaceCorrect.length);
  const distance = levenshtein(noSpacePlayer, noSpaceCorrect);

  if (maxLen > 0 && distance / maxLen <= 0.25) return true;

  return false;
}

/**
 * Lấy bảng xếp hạng từ phòng chơi.
 * Sắp xếp theo điểm giảm dần.
 */
function getLeaderboard(room) {
  const leaderboard = [];

  room.players.forEach((player) => {
    leaderboard.push({
      id: player.id,
      name: player.name,
      score: player.score,
      correctAnswers: player.correctAnswers,
      totalAnswers: player.totalAnswers,
      fastestTime: player.fastestTime === Infinity ? null : player.fastestTime,
      accuracy: player.totalAnswers > 0
        ? Math.round((player.correctAnswers / player.totalAnswers) * 100)
        : 0,
    });
  });

  // Sắp xếp theo điểm giảm dần
  leaderboard.sort((a, b) => b.score - a.score);
  return leaderboard;
}

/**
 * Kết thúc lượt chơi (round).
 * Gửi kết quả lượt và bảng xếp hạng cho tất cả người trong phòng.
 */
function endRound(room) {
  // Cập nhật trạng thái
  room.state = 'round_ended';

  // Xoá timer nếu còn
  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }

  // Xây dựng danh sách kết quả từ roundAnswers
  const results = [];
  room.roundAnswers.forEach((answerData, socketId) => {
    const player = room.players.get(socketId);
    results.push({
      id: player ? player.id : socketId,
      playerId: player ? player.id : socketId,
      name: player ? player.name : 'Unknown',
      playerName: player ? player.name : 'Unknown',
      answered: true,
      answer: answerData.answer,
      correct: answerData.correct,
      time: answerData.time,
      score: answerData.score,
      isFirst: answerData.isFirst,
    });
  });

  // Thêm người chơi chưa trả lời vào kết quả
  room.players.forEach((player, socketId) => {
    if (!room.roundAnswers.has(socketId)) {
      results.push({
        id: player.id,
        playerId: player.id,
        name: player.name,
        playerName: player.name,
        answered: false,
        answer: null,
        correct: false,
        time: null,
        score: 0,
        isFirst: false,
      });
    }
  });

  // Sắp xếp: đúng trước, sau đó theo thời gian tăng dần
  results.sort((a, b) => {
    if (a.correct && !b.correct) return -1;
    if (!a.correct && b.correct) return 1;
    // Cả hai đều đúng hoặc đều sai: sắp xếp theo thời gian
    if (a.time === null && b.time === null) return 0;
    if (a.time === null) return 1;
    if (b.time === null) return -1;
    return a.time - b.time;
  });

  // Lấy tên bài hát đúng cho lượt hiện tại
  const currentSong = room.songs[room.currentRound];
  const correctAnswer = currentSong ? currentSong.title : '';

  // Phát sự kiện kết quả lượt cho cả phòng
  io.to(room.code).emit('round-end', {
    round: room.currentRound + 1,   // 1-based
    totalRounds: room.songs.length,
    correctAnswer,
    results,
    leaderboard: getLeaderboard(room),
  });
}

/**
 * Kết thúc trò chơi.
 * Gửi bảng xếp hạng cuối cùng cho tất cả người trong phòng.
 */
function endGame(room) {
  room.state = 'game_over';

  // Xoá timer nếu còn
  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }

  // Phát sự kiện kết thúc game cho cả phòng
  io.to(room.code).emit('game-over', {
    leaderboard: getLeaderboard(room),
    totalRounds: room.songs.length,
  });
}

/**
 * Dọn dẹp file đã upload của phòng.
 * Xoá tất cả file âm thanh liên quan khi phòng bị đóng.
 */
function cleanupRoomFiles(room) {
  if (!room.songs || room.songs.length === 0) return;

  room.songs.forEach((song) => {
    if (song.fileName) {
      const filePath = path.join(uploadsDir, song.fileName);
      fs.unlink(filePath, (err) => {
        if (err && err.code !== 'ENOENT') {
          console.error(`Lỗi xoá file ${filePath}:`, err.message);
        }
      });
    }
  });
}

// =============================================================================
// Socket.IO — Xử lý kết nối thời gian thực
// =============================================================================

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // ---------------------------------------------------------------------------
  // 1. create-room — Tạo phòng chơi mới
  // ---------------------------------------------------------------------------
  socket.on('create-room', (callback) => {
    const roomCode = generateRoomCode();

    // Tạo đối tượng phòng
    const room = {
      code: roomCode,
      hostSocketId: socket.id,
      players: new Map(),
      songs: [],
      state: 'lobby',
      currentRound: -1,
      roundStartTime: 0,
      roundAnswers: new Map(),
      roundTimer: null,
      roundDuration: 30,
      winnerFound: false,
    };

    // Lưu phòng vào bộ nhớ
    rooms.set(roomCode, room);

    // Socket tham gia room channel và đánh dấu là host
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.isHost = true;

    console.log(`Phòng ${roomCode} được tạo bởi ${socket.id}`);

    if (typeof callback === 'function') {
      callback({ success: true, roomCode });
    }
  });

  // ---------------------------------------------------------------------------
  // 2. join-room — Người chơi tham gia phòng
  // ---------------------------------------------------------------------------
  socket.on('join-room', ({ roomCode, playerName }, callback) => {
    // Kiểm tra phòng tồn tại
    const room = rooms.get(roomCode);
    if (!room) {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Phòng không tồn tại.' });
      }
      return;
    }

    // Kiểm tra phòng đang ở trạng thái lobby
    if (room.state !== 'lobby') {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Trò chơi đã bắt đầu. Không thể tham gia.' });
      }
      return;
    }

    // Kiểm tra tên người chơi hợp lệ
    if (!playerName || !playerName.trim()) {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Vui lòng nhập tên của bạn.' });
      }
      return;
    }

    const trimmedName = playerName.trim();

    // Tạo đối tượng người chơi
    const player = {
      id: socket.id,
      name: trimmedName,
      score: 0,
      correctAnswers: 0,
      totalAnswers: 0,
      fastestTime: Infinity,
      roundResults: [],
    };

    // Thêm người chơi vào phòng
    room.players.set(socket.id, player);

    // Socket tham gia room channel
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.isHost = false;

    console.log(`${trimmedName} (${socket.id}) tham gia phòng ${roomCode}`);

    // Gửi danh sách người chơi cập nhật cho cả phòng
    const playerList = [];
    room.players.forEach((p) => {
      playerList.push({ id: p.id, name: p.name, score: p.score });
    });
    io.to(roomCode).emit('player-joined', { players: playerList });

    if (typeof callback === 'function') {
      callback({ success: true, roomCode, playerName: trimmedName });
    }
  });

  // ---------------------------------------------------------------------------
  // 3. update-songs — Host cập nhật danh sách bài hát
  // ---------------------------------------------------------------------------
  socket.on('update-songs', ({ songs }) => {
    // Chỉ host mới được cập nhật
    if (!socket.isHost || !socket.roomCode) return;

    const room = rooms.get(socket.roomCode);
    if (!room) return;

    room.songs = songs || [];
  });

  // ---------------------------------------------------------------------------
  // 4. start-game — Bắt đầu trò chơi
  // ---------------------------------------------------------------------------
  socket.on('start-game', (data, callback) => {
    if (typeof data === 'function') {
      callback = data;
      data = {};
    }

    if (!socket.isHost || !socket.roomCode) {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Bạn không phải host.' });
      }
      return;
    }

    const room = rooms.get(socket.roomCode);
    if (!room) {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Phòng không tồn tại.' });
      }
      return;
    }

    if (data && data.duration) {
      room.roundDuration = Math.max(5, Math.min(120, parseInt(data.duration, 10) || 30));
    }

    // Kiểm tra có bài hát
    if (!room.songs || room.songs.length === 0) {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Vui lòng thêm ít nhất 1 bài hát.' });
      }
      return;
    }

    // Kiểm tra có người chơi
    if (room.players.size === 0) {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Cần ít nhất 1 người chơi để bắt đầu.' });
      }
      return;
    }

    // Reset điểm số tất cả người chơi
    room.players.forEach((player) => {
      player.score = 0;
      player.correctAnswers = 0;
      player.totalAnswers = 0;
      player.fastestTime = Infinity;
      player.roundResults = [];
    });

    // Cập nhật trạng thái phòng
    room.state = 'playing';
    room.currentRound = -1;

    // Gửi danh sách người chơi cho sự kiện game-started
    const playerList = [];
    room.players.forEach((p) => {
      playerList.push({ id: p.id, name: p.name, score: p.score });
    });

    // Thông báo cho cả phòng
    io.to(room.code).emit('game-started', {
      totalRounds: room.songs.length,
      players: playerList,
    });

    console.log(`Trò chơi bắt đầu tại phòng ${room.code} — ${room.songs.length} lượt, ${room.players.size} người chơi`);

    if (typeof callback === 'function') {
      callback({ success: true });
    }
  });

  // ---------------------------------------------------------------------------
  // 5. next-round — Chuyển sang lượt tiếp theo
  // ---------------------------------------------------------------------------
  socket.on('next-round', (callback) => {
    if (!socket.isHost || !socket.roomCode) {
      if (typeof callback === 'function') {
        callback({ success: false });
      }
      return;
    }

    const room = rooms.get(socket.roomCode);
    if (!room) {
      if (typeof callback === 'function') {
        callback({ success: false });
      }
      return;
    }

    // Tăng lượt chơi
    room.currentRound++;

    // Kiểm tra đã hết bài hát chưa
    if (room.currentRound >= room.songs.length) {
      endGame(room);
      if (typeof callback === 'function') {
        callback({ success: true, gameOver: true });
      }
      return;
    }

    // Chuẩn bị lượt mới
    const song = room.songs[room.currentRound];
    room.state = 'round_active';
    room.roundAnswers = new Map();
    room.winnerFound = false;
    room.roundStartTime = Date.now();

    // Đặt timer tự động kết thúc lượt sau roundDuration giây
    room.roundTimer = setTimeout(() => {
      endRound(room);
    }, room.roundDuration * 1000);

    // Đếm số ký tự KHÔNG tính dấu cách
    const charCountWithoutSpaces = song.title.replace(/\s+/g, '').length;
    const wordCount = song.title.trim().split(/\s+/).filter(Boolean).length;

    // Thông báo bắt đầu lượt cho cả phòng
    io.to(room.code).emit('round-start', {
      round: room.currentRound + 1,       // 1-based
      totalRounds: room.songs.length,
      audioUrl: song.url,
      duration: room.roundDuration,
      hintLength: charCountWithoutSpaces, // Gợi ý: số ký tự KHÔNG tính dấu cách
      wordCount: wordCount,               // Số từ
    });

    console.log(`Phòng ${room.code} — Lượt ${room.currentRound + 1}/${room.songs.length}: "${song.title}"`);

    if (typeof callback === 'function') {
      callback({ success: true, gameOver: false });
    }
  });

  // ---------------------------------------------------------------------------
  // 6. submit-answer — Người chơi gửi đáp án
  // ---------------------------------------------------------------------------
  socket.on('submit-answer', ({ answer }, callback) => {
    const roomCode = socket.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;

    // Kiểm tra phòng và trạng thái
    if (!room || room.state !== 'round_active') {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Lượt chơi chưa bắt đầu hoặc đã kết thúc.' });
      }
      return;
    }

    // Kiểm tra người chơi tồn tại trong phòng
    const player = room.players.get(socket.id);
    if (!player) {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Bạn không ở trong phòng này.' });
      }
      return;
    }

    // Kiểm tra đã trả lời chưa
    if (room.roundAnswers.has(socket.id)) {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Bạn đã trả lời rồi.' });
      }
      return;
    }

    // Tính thời gian phản hồi (ms)
    const responseTime = Date.now() - room.roundStartTime;

    // Kiểm tra đáp án
    const currentSong = room.songs[room.currentRound];
    const correct = isAnswerCorrect(answer, currentSong.title);

    // Xác định có phải người đầu tiên trả lời đúng không
    let isFirst = false;
    if (correct && !room.winnerFound) {
      isFirst = true;
      room.winnerFound = true;
    }

    // Tính điểm
    // Đúng: 1000 - floor(responseTime / (roundDuration * 10)) + bonus 500 nếu là người đầu tiên
    // Sai: 0 điểm
    let score = 0;
    if (correct) {
      score = Math.max(0, 1000 - Math.floor(responseTime / (room.roundDuration * 10)));
      if (isFirst) {
        score += 500;
      }
    }

    // Lưu câu trả lời
    const answerData = {
      answer,
      time: responseTime,
      correct,
      isFirst,
      score,
    };
    room.roundAnswers.set(socket.id, answerData);

    // Cập nhật thống kê người chơi
    player.score += score;
    player.totalAnswers++;
    if (correct) {
      player.correctAnswers++;
      if (responseTime < player.fastestTime) {
        player.fastestTime = responseTime;
      }
    }
    player.roundResults.push({
      round: room.currentRound + 1,
      answer,
      correct,
      time: responseTime,
      score,
      isFirst,
    });

    // Thông báo cho host biết ai đã trả lời (không tiết lộ đáp án)
    const hostSocket = io.sockets.sockets.get(room.hostSocketId);
    if (hostSocket) {
      hostSocket.emit('player-answered', {
        playerId: player.id,
        playerName: player.name,
        answered: true,
        totalAnswered: room.roundAnswers.size,
        totalPlayers: room.players.size,
      });
    }

    // Phản hồi cho người chơi
    if (typeof callback === 'function') {
      callback({
        success: true,
        correct,
        time: responseTime,
        score,
        isFirst,
      });
    }

    // Kiểm tra nếu tất cả đã trả lời → kết thúc lượt sau 1 giây
    if (room.roundAnswers.size >= room.players.size) {
      if (room.roundTimer) {
        clearTimeout(room.roundTimer);
        room.roundTimer = null;
      }
      setTimeout(() => {
        // Kiểm tra lại trạng thái trước khi kết thúc (tránh race condition)
        if (room.state === 'round_active') {
          endRound(room);
        }
      }, 1000);
    }
  });

  // ---------------------------------------------------------------------------
  // 7. end-round — Host kết thúc lượt thủ công
  // ---------------------------------------------------------------------------
  socket.on('end-round', () => {
    if (!socket.isHost || !socket.roomCode) return;

    const room = rooms.get(socket.roomCode);
    if (!room) return;

    if (room.state === 'round_active') {
      // Xoá timer và kết thúc lượt
      if (room.roundTimer) {
        clearTimeout(room.roundTimer);
        room.roundTimer = null;
      }
      endRound(room);
    } else if (room.state === 'round_ended') {
      // Re-emit round-end để host không bao giờ bị kẹt lại màn hình game
      const song = room.songs[room.currentRound];
      const results = [];
      room.roundAnswers.forEach((answerData, sId) => {
        const player = room.players.get(sId);
        results.push({
          id: player ? player.id : sId,
          playerId: player ? player.id : sId,
          name: player ? player.name : 'Unknown',
          playerName: player ? player.name : 'Unknown',
          answered: true,
          answer: answerData.answer,
          correct: answerData.correct,
          time: answerData.time,
          score: answerData.score,
          isFirst: answerData.isFirst,
        });
      });
      room.players.forEach((player, sId) => {
        if (!room.roundAnswers.has(sId)) {
          results.push({
            id: player.id,
            playerId: player.id,
            name: player.name,
            playerName: player.name,
            answered: false,
            answer: null,
            correct: false,
            time: null,
            score: 0,
            isFirst: false,
          });
        }
      });
      results.sort((a, b) => {
        if (a.correct && !b.correct) return -1;
        if (!a.correct && b.correct) return 1;
        if (a.time === null && b.time === null) return 0;
        if (a.time === null) return 1;
        if (b.time === null) return -1;
        return a.time - b.time;
      });

      const leaderboard = getLeaderboard(room);
      socket.emit('round-end', {
        round: room.currentRound + 1,
        totalRounds: room.songs.length,
        correctAnswer: song ? song.title : '',
        results,
        leaderboard,
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 8. disconnect — Xử lý ngắt kết nối
  // ---------------------------------------------------------------------------
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);

    const roomCode = socket.roomCode;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    if (socket.isHost) {
      // Host ngắt kết nối → đóng phòng
      console.log(`Host rời phòng ${roomCode} — đóng phòng`);

      // Thông báo cho tất cả người chơi
      io.to(roomCode).emit('room-closed');

      // Xoá timer nếu có
      if (room.roundTimer) {
        clearTimeout(room.roundTimer);
        room.roundTimer = null;
      }

      // Dọn dẹp file đã upload
      cleanupRoomFiles(room);

      // Xoá phòng
      rooms.delete(roomCode);
    } else {
      // Người chơi ngắt kết nối → xoá khỏi phòng
      const player = room.players.get(socket.id);
      const playerName = player ? player.name : 'Unknown';

      room.players.delete(socket.id);
      room.roundAnswers.delete(socket.id);

      console.log(`${playerName} rời phòng ${roomCode}`);

      // Thông báo cho phòng
      const playerList = [];
      room.players.forEach((p) => {
        playerList.push({ id: p.id, name: p.name, score: p.score });
      });
      io.to(roomCode).emit('player-left', { players: playerList });
    }
  });
});

// =============================================================================
// Khởi động server
// =============================================================================

server.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLanIpAddress();
  console.log(`🎵 Music Quiz Game server running:`);
  console.log(`   - Local: http://localhost:${PORT}`);
  if (lanIp && lanIp !== 'localhost') {
    console.log(`   - Wi-Fi / LAN: http://${lanIp}:${PORT}`);
  }
});

module.exports = server;
module.exports.app = app;
