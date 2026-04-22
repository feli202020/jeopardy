const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 50e6 });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'quizzes.json');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'public', 'uploads');

// Ensure directories exist at startup
[DATA_DIR, UPLOAD_DIR].forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });

function loadQuizzes() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}

function saveQuizzes(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ─── REST API ────────────────────────────────────────────────────────────────

app.get('/api/quizzes', (req, res) => {
  const q = loadQuizzes();
  res.json(Object.values(q).map(({ id, title, categories }) => ({ id, title, categoryCount: categories.length })));
});

app.get('/api/quizzes/:id', (req, res) => {
  const q = loadQuizzes();
  if (!q[req.params.id]) return res.status(404).json({ error: 'Not found' });
  res.json(q[req.params.id]);
});

app.post('/api/quizzes', (req, res) => {
  const q = loadQuizzes();
  const id = uuidv4();
  const quiz = { id, title: req.body.title || 'Neues Quiz', categories: [] };
  q[id] = quiz;
  saveQuizzes(q);
  res.json(quiz);
});

app.put('/api/quizzes/:id', (req, res) => {
  const q = loadQuizzes();
  if (!q[req.params.id]) return res.status(404).json({ error: 'Not found' });
  q[req.params.id] = { ...q[req.params.id], ...req.body, id: req.params.id };
  saveQuizzes(q);
  res.json(q[req.params.id]);
});

app.delete('/api/quizzes/:id', (req, res) => {
  const q = loadQuizzes();
  delete q[req.params.id];
  saveQuizzes(q);
  res.json({ ok: true });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: `/uploads/${req.file.filename}`, type: req.file.mimetype });
});

// ─── GAME STATE ──────────────────────────────────────────────────────────────

// rooms: { [roomCode]: GameRoom }
const rooms = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createRoom(quizId, gamemasterSocketId) {
  let code;
  do { code = generateCode(); } while (rooms[code]);

  const q = loadQuizzes();
  const quiz = q[quizId];
  if (!quiz) return null;

  // Build board state
  const board = quiz.categories.map(cat => ({
    name: cat.name,
    questions: cat.questions.map(q => ({
      ...q,
      answered: false
    }))
  }));

  rooms[code] = {
    code,
    quizId,
    quiz,
    board,
    gamemasterId: gamemasterSocketId,
    players: {},       // { socketId: { name, score, socketId } }
    phase: 'lobby',    // lobby | board | question | buzzed | judging | end
    activeQuestion: null,  // { categoryIdx, questionIdx }
    buzzer: null,          // first buzzer socketId
    buzzOrder: [],
    lockedOut: new Set(),  // players locked out this question
  };
  return rooms[code];
}

function getRoomBySocket(socketId) {
  return Object.values(rooms).find(
    r => r.gamemasterId === socketId || r.players[socketId]
  );
}

function roomPublicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    board: room.board.map(cat => ({
      name: cat.name,
      questions: cat.questions.map(q => ({
        value: q.value,
        answered: q.answered,
        isDailyDouble: q.isDailyDouble
      }))
    })),
    players: Object.values(room.players),
    activeQuestion: room.activeQuestion ? {
      categoryIdx: room.activeQuestion.categoryIdx,
      questionIdx: room.activeQuestion.questionIdx,
      // Only public info — no answer
      value: activeQ(room)?.value,
      isDailyDouble: activeQ(room)?.isDailyDouble,
      mediaType: activeQ(room)?.mediaType,
      mediaUrl: activeQ(room)?.mediaUrl,
      question: activeQ(room)?.question,
    } : null,
    buzzer: room.buzzer ? room.players[room.buzzer]?.name : null,
    buzzOrder: room.buzzOrder.map(id => room.players[id]?.name).filter(Boolean),
  };
}

function activeQ(room) {
  if (!room.activeQuestion) return null;
  const { categoryIdx, questionIdx } = room.activeQuestion;
  return room.board[categoryIdx]?.questions[questionIdx] || null;
}

function gamemasterState(room) {
  const pub = roomPublicState(room);
  if (room.activeQuestion) {
    pub.activeQuestion = {
      ...pub.activeQuestion,
      answer: activeQ(room)?.answer,
    };
  }
  return pub;
}

// ─── SOCKET EVENTS ───────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  // ── GAMEMASTER: create room ──
  socket.on('gm:create_room', ({ quizId }, cb) => {
    const room = createRoom(quizId, socket.id);
    if (!room) return cb({ error: 'Quiz not found' });
    socket.join(room.code);
    cb({ code: room.code, state: gamemasterState(room) });
  });

  // ── PLAYER: join room ──
  socket.on('player:join', ({ code, name }, cb) => {
    const room = rooms[code?.toUpperCase()];
    if (!room) return cb({ error: 'Raum nicht gefunden' });
    if (room.phase !== 'lobby') return cb({ error: 'Spiel bereits gestartet' });
    if (!name?.trim()) return cb({ error: 'Bitte Namen eingeben' });

    const playerName = name.trim().substring(0, 20);
    const exists = Object.values(room.players).find(p => p.name.toLowerCase() === playerName.toLowerCase());
    if (exists) return cb({ error: 'Name bereits vergeben' });

    room.players[socket.id] = { name: playerName, score: 0, socketId: socket.id };
    socket.join(room.code);

    io.to(room.code).emit('room:update', roomPublicState(room));
    io.to(room.gamemasterId).emit('room:update', gamemasterState(room));
    cb({ ok: true, state: roomPublicState(room), playerId: socket.id });
  });

  // ── GAMEMASTER: start game ──
  socket.on('gm:start_game', (_, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    if (Object.keys(room.players).length === 0) return cb?.({ error: 'Keine Spieler' });
    room.phase = 'board';
    io.to(room.code).emit('room:update', roomPublicState(room));
    io.to(room.gamemasterId).emit('room:update', gamemasterState(room));
    cb?.({ ok: true });
  });

  // ── GAMEMASTER: select question ──
  socket.on('gm:select_question', ({ categoryIdx, questionIdx }, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    if (room.phase !== 'board') return;

    const q = room.board[categoryIdx]?.questions[questionIdx];
    if (!q || q.answered) return;

    room.activeQuestion = { categoryIdx, questionIdx };
    room.buzzer = null;
    room.buzzOrder = [];
    room.lockedOut = new Set();
    room.phase = 'question';

    io.to(room.code).emit('room:update', roomPublicState(room));
    io.to(room.gamemasterId).emit('room:update', gamemasterState(room));
    cb?.({ ok: true });
  });

  // ── PLAYER: buzz ──
  socket.on('player:buzz', (_, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || !room.players[socket.id]) return;
    if (room.phase !== 'question') return;
    if (room.lockedOut.has(socket.id)) return cb?.({ error: 'Du bist gesperrt' });

    if (!room.buzzOrder.includes(socket.id)) {
      room.buzzOrder.push(socket.id);
    }
    if (!room.buzzer) {
      room.buzzer = socket.id;
      room.phase = 'buzzed';
      io.to(room.code).emit('room:update', roomPublicState(room));
      io.to(room.gamemasterId).emit('room:update', gamemasterState(room));
    }
    cb?.({ ok: true });
  });

  // ── GAMEMASTER: judge answer ──
  socket.on('gm:judge', ({ correct }, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    if (room.phase !== 'buzzed') return;

    const q = activeQ(room);
    const buzzerId = room.buzzer;
    const player = room.players[buzzerId];
    if (!player || !q) return;

    const pts = q.isDailyDouble ? q.value * 2 : q.value;

    if (correct) {
      player.score += pts;
      q.answered = true;
      room.phase = 'board';
      room.activeQuestion = null;
      room.buzzer = null;
      room.buzzOrder = [];
      room.lockedOut = new Set();
    } else {
      player.score -= pts;
      room.lockedOut.add(buzzerId);
      room.buzzer = null;
      // Check if all players locked out → give up
      const activePlayers = Object.keys(room.players).filter(id => !room.lockedOut.has(id));
      if (activePlayers.length === 0) {
        q.answered = true;
        room.phase = 'board';
        room.activeQuestion = null;
        room.buzzer = null;
        room.buzzOrder = [];
        room.lockedOut = new Set();
      } else {
        room.phase = 'question';
      }
    }

    io.to(room.code).emit('room:update', roomPublicState(room));
    io.to(room.gamemasterId).emit('room:update', gamemasterState(room));
    cb?.({ ok: true });
  });

  // ── GAMEMASTER: skip question (nobody buzzes / time's up) ──
  socket.on('gm:skip_question', (_, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    if (!['question', 'buzzed'].includes(room.phase)) return;

    const q = activeQ(room);
    if (q) q.answered = true;
    room.phase = 'board';
    room.activeQuestion = null;
    room.buzzer = null;
    room.buzzOrder = [];
    room.lockedOut = new Set();

    io.to(room.code).emit('room:update', roomPublicState(room));
    io.to(room.gamemasterId).emit('room:update', gamemasterState(room));
    cb?.({ ok: true });
  });

  // ── GAMEMASTER: end game ──
  socket.on('gm:end_game', (_, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    room.phase = 'end';
    io.to(room.code).emit('room:update', roomPublicState(room));
    io.to(room.gamemasterId).emit('room:update', gamemasterState(room));
    cb?.({ ok: true });
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;

    if (room.gamemasterId === socket.id) {
      io.to(room.code).emit('game:closed', { reason: 'Gamemaster hat das Spiel beendet' });
      delete rooms[room.code];
      return;
    }

    if (room.players[socket.id]) {
      delete room.players[socket.id];
      if (room.buzzer === socket.id) {
        room.buzzer = null;
        room.phase = room.activeQuestion ? 'question' : 'board';
      }
      io.to(room.code).emit('room:update', roomPublicState(room));
      io.to(room.gamemasterId).emit('room:update', gamemasterState(room));
    }
  });
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => console.log(`Jeopardy server running on http://${HOST}:${PORT}`));
