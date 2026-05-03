require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const session = require('express-session');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 50e6 });

// ─── SUPABASE ────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────

app.use(express.json({ limit: '50mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'jeopardy-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  }
}));

// ─── AUTH ─────────────────────────────────────────────────────────────────────

function requireGM(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Nicht angemeldet' });
  res.redirect('/login.html');
}

// Geschützte Seiten
app.get('/gamemaster.html', requireGM, (req, res) => {
  res.sendFile('gamemaster.html', { root: __dirname + '/public' });
});
app.get('/editor.html', requireGM, (req, res) => {
  res.sendFile('editor.html', { root: __dirname + '/public' });
});

app.use(express.static(__dirname + '/public'));

// ─── AUTH ROUTES ─────────────────────────────────────────────────────────────

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth/check', (req, res) => {
  res.json({ ok: !!(req.session && req.session.userId) });
});

// ─── USER ACCOUNTS (username + password, eigene Tabelle) ─────────────────────

const USERNAME_RE = /^[a-zA-Z0-9_\-]{4,16}$/;

app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Benutzername: 4–16 Zeichen, nur Buchstaben, Zahlen, _ oder -' });
  if (password.length < 4 || password.length > 16) return res.status(400).json({ error: 'Passwort muss 4–16 Zeichen lang sein' });

  // Check username taken
  const { data: existing } = await supabase.from('users').select('id').ilike('username', username).maybeSingle();
  if (existing) return res.status(409).json({ error: 'Benutzername bereits vergeben' });

  const hash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  const { error } = await supabase.from('users').insert({ id, username, password_hash: hash });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.post('/api/auth/user-login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });

  const { data: user } = await supabase.from('users').select('id, username, password_hash').ilike('username', username).maybeSingle();
  if (!user) return res.status(401).json({ error: 'Falscher Benutzername oder Passwort' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Falscher Benutzername oder Passwort' });

  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ ok: true, username: user.username });
});

app.post('/api/auth/user-logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session) return res.json({ loggedIn: false });
  res.json({
    loggedIn: !!req.session.userId,
    userId: req.session.userId || null,
    username: req.session.username || null,
  });
});

// ─── QUIZ REST API ────────────────────────────────────────────────────────────

app.get('/api/quizzes', requireGM, async (req, res) => {
  const userId = req.session.userId;
  let query = supabase.from('quizzes').select('id, title, categories, user_id').order('created_at', { ascending: false });
  if (userId) {
    query = query.eq('user_id', userId);
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(q => ({
    id: q.id,
    title: q.title,
    categoryCount: (q.categories || []).length
  })));
});

app.get('/api/quizzes/:id', requireGM, async (req, res) => {
  const { data, error } = await supabase
    .from('quizzes')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  // Ownership check for user-accounts
  if (req.session.userId && data.user_id && data.user_id !== req.session.userId) {
    return res.status(403).json({ error: 'Kein Zugriff' });
  }
  res.json(data);
});

app.post('/api/quizzes', requireGM, async (req, res) => {
  const id = uuidv4();
  const quiz = {
    id,
    title: req.body.title || 'Neues Quiz',
    categories: req.body.categories || [],
    user_id: req.session.userId || null,
  };
  const { data, error } = await supabase.from('quizzes').insert(quiz).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/quizzes/:id', requireGM, async (req, res) => {
  const { id } = req.params;
  // Ownership check
  if (req.session.userId) {
    const { data: existing } = await supabase.from('quizzes').select('user_id').eq('id', id).single();
    if (existing && existing.user_id && existing.user_id !== req.session.userId) {
      return res.status(403).json({ error: 'Kein Zugriff' });
    }
  }
  const update = { ...req.body, id };
  const { data, error } = await supabase
    .from('quizzes')
    .update(update)
    .eq('id', id)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ error: error?.message || 'Not found' });
  res.json(data);
});

app.delete('/api/quizzes/:id', requireGM, async (req, res) => {
  const { id } = req.params;
  if (req.session.userId) {
    const { data: existing } = await supabase.from('quizzes').select('user_id').eq('id', id).single();
    if (existing && existing.user_id && existing.user_id !== req.session.userId) {
      return res.status(403).json({ error: 'Kein Zugriff' });
    }
  }
  const { error } = await supabase.from('quizzes').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── UPLOAD → SUPABASE STORAGE ───────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.post('/api/upload', requireGM, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  const ext = req.file.originalname.split('.').pop();
  const filename = `${uuidv4()}.${ext}`;

  const { error } = await supabase.storage
    .from('media')
    .upload(filename, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false,
    });

  if (error) return res.status(500).json({ error: error.message });

  const { data: { publicUrl } } = supabase.storage.from('media').getPublicUrl(filename);
  res.json({ url: publicUrl, type: req.file.mimetype });
});

// ─── GAME STATE ──────────────────────────────────────────────────────────────

const rooms = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function createRoom(quizId, gamemasterSocketId) {
  let code;
  do { code = generateCode(); } while (rooms[code]);

  const { data: quiz, error } = await supabase
    .from('quizzes')
    .select('*')
    .eq('id', quizId)
    .single();
  if (error || !quiz) return null;

  const board = quiz.categories.map(cat => ({
    name: cat.name,
    questions: cat.questions.map(q => ({ ...q, answered: false }))
  }));

  rooms[code] = {
    code,
    quizId,
    quiz,
    board,
    gamemasterId: gamemasterSocketId,
    players: {},
    phase: 'lobby',
    activeQuestion: null,
    buzzer: null,
    buzzOrder: [],
    lockedOut: new Set(),
    questionRevealed: false,
    buzzerClosed: false,
    // Timer state
    timer: null,         // { duration: 30, remaining: 30, running: false }
    timerInterval: null, // server-side interval handle
    // Hint state
    hintRevealed: false,
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
        isDailyDouble: q.isDailyDouble,
      }))
    })),
    players: Object.values(room.players).map(p => ({
      name: p.name, score: p.score, socketId: p.socketId, online: p.online
    })),
    activeQuestion: room.activeQuestion ? {
      categoryIdx: room.activeQuestion.categoryIdx,
      questionIdx: room.activeQuestion.questionIdx,
      value: activeQ(room)?.value,
      isDailyDouble: activeQ(room)?.isDailyDouble,
      mediaType: activeQ(room)?.mediaType,
      mediaUrl: activeQ(room)?.mediaUrl,
      question: room.questionRevealed ? activeQ(room)?.question : null,
      hint: room.hintRevealed ? (activeQ(room)?.hint || null) : null,
    } : null,
    questionRevealed: !!room.questionRevealed,
    hintRevealed: !!room.hintRevealed,
    buzzerClosed: !!room.buzzerClosed,
    buzzer: room.buzzer ? room.players[room.buzzer]?.name : null,
    buzzOrder: room.buzzOrder.map(id => room.players[id]?.name).filter(Boolean),
    timer: room.timer ? {
      duration: room.timer.duration,
      remaining: room.timer.remaining,
      running: room.timer.running,
    } : null,
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
      question: activeQ(room)?.question,
      answer: activeQ(room)?.answer,
      hint: activeQ(room)?.hint || null,
    };
  }
  return pub;
}

function broadcastRoom(room) {
  io.to(room.code).emit('room:update', roomPublicState(room));
  io.to(room.gamemasterId).emit('room:update', gamemasterState(room));
}

function clearRoomTimer(room) {
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
}

function startRoomTimer(room) {
  clearRoomTimer(room);
  if (!room.timer) return;
  room.timer.running = true;
  room.timerInterval = setInterval(() => {
    if (!room.timer || !room.timer.running) { clearRoomTimer(room); return; }
    room.timer.remaining = Math.max(0, room.timer.remaining - 1);
    broadcastRoom(room);
    if (room.timer.remaining <= 0) {
      room.timer.running = false;
      clearRoomTimer(room);
      // Emit a dedicated timeout event so clients can react
      io.to(room.code).emit('timer:timeout');
    }
  }, 1000);
}

// ─── SOCKET EVENTS ───────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('gm:create_room', async ({ quizId }, cb) => {
    const room = await createRoom(quizId, socket.id);
    if (!room) return cb({ error: 'Quiz not found' });
    socket.join(room.code);
    cb({ code: room.code, state: gamemasterState(room) });
  });

  socket.on('player:join', ({ code, name }, cb) => {
    const room = rooms[code?.toUpperCase()];
    if (!room) return cb({ error: 'Raum nicht gefunden' });
    if (!name?.trim()) return cb({ error: 'Bitte Namen eingeben' });

    const playerName = name.trim().substring(0, 20);
    const existing = Object.values(room.players).find(
      p => p.name.toLowerCase() === playerName.toLowerCase() && !p.online
    );

    if (existing) {
      delete room.players[existing.socketId];
      existing.socketId = socket.id;
      existing.online = true;
      room.players[socket.id] = existing;
      if (room.buzzer === existing.socketId) room.buzzer = socket.id;
      room.lockedOut.delete(existing.socketId);
      socket.join(room.code);
      broadcastRoom(room);
      return cb({ ok: true, state: roomPublicState(room), playerId: socket.id, rejoined: true });
    }

    if (room.phase !== 'lobby') return cb({ error: 'Spiel bereits gestartet' });
    const nameTaken = Object.values(room.players).find(
      p => p.name.toLowerCase() === playerName.toLowerCase()
    );
    if (nameTaken) return cb({ error: 'Name bereits vergeben' });

    room.players[socket.id] = { name: playerName, score: 0, socketId: socket.id, online: true };
    socket.join(room.code);
    broadcastRoom(room);
    cb({ ok: true, state: roomPublicState(room), playerId: socket.id });
  });

  socket.on('observer:join', ({ code }, cb) => {
    const room = rooms[code?.toUpperCase()];
    if (!room) return cb?.({ error: 'Raum nicht gefunden' });
    socket.join(room.code);
    cb?.({ ok: true, state: roomPublicState(room) });
  });

  socket.on('gm:start_game', (_, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    if (Object.keys(room.players).length === 0) return cb?.({ error: 'Keine Spieler' });
    room.phase = 'board';
    broadcastRoom(room);
    cb?.({ ok: true });
  });

  socket.on('gm:select_question', ({ categoryIdx, questionIdx }, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    if (room.phase !== 'board') return;
    const q = room.board[categoryIdx]?.questions[questionIdx];
    if (!q) return;
    // Allow re-selecting answered questions (repeat feature)
    room.activeQuestion = { categoryIdx, questionIdx };
    room.buzzer = null;
    room.buzzOrder = [];
    room.lockedOut = new Set();
    room.phase = 'question';
    room.questionRevealed = !!(q.mediaUrl);
    room.buzzerClosed = false;
    room.hintRevealed = false;
    // Reset timer if configured
    if (room.pendingTimerDuration) {
      room.timer = { duration: room.pendingTimerDuration, remaining: room.pendingTimerDuration, running: false };
    } else {
      room.timer = null;
    }
    clearRoomTimer(room);
    broadcastRoom(room);
    cb?.({ ok: true });
  });

  socket.on('gm:reveal_question', (_, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    if (room.phase !== 'question') return;
    room.questionRevealed = true;
    broadcastRoom(room);
    cb?.({ ok: true });
  });

  socket.on('gm:reveal_hint', (_, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    if (!['question', 'buzzed'].includes(room.phase)) return;
    room.hintRevealed = true;
    broadcastRoom(room);
    cb?.({ ok: true });
  });

  // Timer: GM sets the default duration for next question (0 = off)
  socket.on('gm:set_timer', ({ duration }, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    room.pendingTimerDuration = duration > 0 ? duration : 0;
    cb?.({ ok: true });
  });

  // Timer: GM starts the countdown for the active question
  socket.on('gm:start_timer', (_, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    if (!room.timer) return cb?.({ error: 'Kein Timer konfiguriert' });
    if (room.timer.running) return cb?.({ ok: true });
    startRoomTimer(room);
    broadcastRoom(room);
    cb?.({ ok: true });
  });

  socket.on('gm:stop_timer', (_, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    clearRoomTimer(room);
    if (room.timer) room.timer.running = false;
    broadcastRoom(room);
    cb?.({ ok: true });
  });

  socket.on('gm:reset_timer', (_, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    clearRoomTimer(room);
    if (room.timer) {
      room.timer.remaining = room.timer.duration;
      room.timer.running = false;
    }
    broadcastRoom(room);
    cb?.({ ok: true });
  });

  // Manual score adjustment by GM
  socket.on('gm:set_score', ({ socketId, score }, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    const player = room.players[socketId];
    if (!player) return cb?.({ error: 'Spieler nicht gefunden' });
    const parsed = parseInt(score);
    if (isNaN(parsed)) return cb?.({ error: 'Ungültiger Wert' });
    player.score = parsed;
    broadcastRoom(room);
    cb?.({ ok: true });
  });

  socket.on('player:buzz', (_, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || !room.players[socket.id]) return;
    if (room.phase !== 'question') return;
    if (room.lockedOut.size >= 3) return cb?.({ error: 'Maximale Buzzer-Versuche erreicht' });
    if (room.lockedOut.has(socket.id)) return cb?.({ error: 'Du bist gesperrt' });
    if (!room.buzzOrder.includes(socket.id)) room.buzzOrder.push(socket.id);
    if (!room.buzzer) {
      room.buzzer = socket.id;
      room.phase = 'buzzed';
      // Pause timer when someone buzzes
      if (room.timer?.running) {
        clearRoomTimer(room);
        room.timer.running = false;
      }
      broadcastRoom(room);
    }
    cb?.({ ok: true });
  });

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
      room.questionRevealed = false;
      room.buzzerClosed = false;
      room.hintRevealed = false;
      clearRoomTimer(room);
      room.timer = null;
    } else {
      player.score -= pts;
      room.lockedOut.add(buzzerId);
      room.buzzer = null;
      room.phase = 'question';
      room.buzzerClosed = room.lockedOut.size >= 3;
    }
    broadcastRoom(room);
    cb?.({ ok: true });
  });

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
    room.questionRevealed = false;
    room.buzzerClosed = false;
    room.hintRevealed = false;
    clearRoomTimer(room);
    room.timer = null;
    broadcastRoom(room);
    cb?.({ ok: true });
  });

  socket.on('gm:media', ({ action, time }, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    io.to(room.code).emit('media:sync', { action, time });
    cb?.({ ok: true });
  });

  socket.on('gm:end_game', (_, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    clearRoomTimer(room);
    room.phase = 'end';
    broadcastRoom(room);
    cb?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;
    if (room.gamemasterId === socket.id) {
      clearRoomTimer(room);
      io.to(room.code).emit('game:closed', { reason: 'Gamemaster hat das Spiel beendet' });
      delete rooms[room.code];
      return;
    }
    if (room.players[socket.id]) {
      room.players[socket.id].online = false;
      if (room.buzzer === socket.id) {
        room.buzzer = null;
        room.lockedOut.add(socket.id);
        const activePlayers = Object.keys(room.players).filter(
          id => room.players[id].online && !room.lockedOut.has(id)
        );
        room.phase = activePlayers.length > 0 ? 'question' : 'board';
        if (room.phase === 'board') {
          room.activeQuestion = null;
          room.buzzOrder = [];
          room.lockedOut = new Set();
          clearRoomTimer(room);
          room.timer = null;
        }
      }
      broadcastRoom(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`Jeopardy server running on http://${HOST}:${PORT}`);

  if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(() => {
      const url = process.env.RENDER_EXTERNAL_URL + '/api/auth/check';
      fetch(url).catch(() => {});
    }, 10 * 60 * 1000);
  }
});
