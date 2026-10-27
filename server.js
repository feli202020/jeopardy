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

  try {
    // Check username taken
    const { data: existing } = await supabase.from('users').select('id').ilike('username', username).maybeSingle();
    if (existing) return res.status(409).json({ error: 'Benutzername bereits vergeben' });

    const hash = await bcrypt.hash(password, 10);
    const id = uuidv4();
    const { error } = await supabase.from('users').insert({ id, username, password_hash: hash });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    console.error('[register] Datenbank nicht erreichbar:', e.message);
    res.status(503).json({ error: 'Datenbank nicht erreichbar. Bitte später erneut versuchen.' });
  }
});

app.post('/api/auth/user-login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });

  try {
    const { data: user } = await supabase.from('users').select('id, username, password_hash').ilike('username', username).maybeSingle();
    if (!user) return res.status(401).json({ error: 'Falscher Benutzername oder Passwort' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Falscher Benutzername oder Passwort' });

    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ ok: true, username: user.username });
  } catch (e) {
    console.error('[login] Datenbank nicht erreichbar:', e.message);
    res.status(503).json({ error: 'Datenbank nicht erreichbar. Bitte später erneut versuchen.' });
  }
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
    // Team-Modus: 'solo' = jeder für sich, 'teams' = Punkte & Lockout pro Team
    mode: 'solo',
    teams: {},           // { teamId: { id, name, score, color } }
    // Max. Fehlversuche pro Frage (GM-einstellbar, 0 = unbegrenzt)
    maxLockouts: 3,
    // Timer state
    timer: null,         // { duration: 30, remaining: 30, running: false }
    timerInterval: null, // server-side interval handle
  };
  return rooms[code];
}

function getRoomBySocket(socketId) {
  return Object.values(rooms).find(
    r => r.gamemasterId === socketId || r.players[socketId]
  );
}

// ─── TEAM-HELPER ─────────────────────────────────────────────────────────────

// 16 Farben, rechnerisch auf maximalen Abstand optimiert: jeder Ton liegt
// sowohl normalsichtig als auch bei Rot-Gruen-Schwaeche (Prot-/Deuteranopie)
// klar von allen anderen entfernt und hat >=4.5:1 Kontrast zum dunklen
// Hintergrund. Die Laenge bestimmt zugleich die maximale Teamzahl.
const TEAM_COLORS = [
  '#e48b81', // Lachs
  '#ee5b2b', // Orangerot
  '#d78c42', // Ocker
  '#f0d094', // Sand
  '#eeee2b', // Gelb
  '#9ff471', // Hellgruen
  '#3eee2b', // Gruen
  '#79ecad', // Mint
  '#8ef6f6', // Cyan
  '#2b96ee', // Blau
  '#94c6f0', // Hellblau
  '#b494f0', // Lavendel
  '#d84cf0', // Magenta
  '#f471d3', // Pink
  '#e3a0c9', // Altrosa
  '#f04c85', // Himbeere
];

// Erste Farbe, die noch kein Team belegt — nie zweimal dieselbe.
function freeTeamColor(room) {
  const used = new Set(Object.values(room.teams).map(t => t.color));
  return TEAM_COLORS.find(c => !used.has(c)) || null;
}

// Die "Buzz-Einheit": im Team-Modus das Team, sonst der Spieler selbst.
// Darauf wirken Lockout und Punkte.
function buzzUnitId(room, socketId) {
  const p = room.players[socketId];
  if (!p) return null;
  if (room.mode === 'teams' && p.teamId) return 'team:' + p.teamId;
  return socketId;
}

// Öffentlich sichtbarer Name einer Buzz-Einheit (Team-Modus: nur der Teamname)
function unitLabel(room, socketId) {
  const p = room.players[socketId];
  if (!p) return null;
  if (room.mode === 'teams' && p.teamId) return room.teams[p.teamId]?.name || p.name;
  return p.name;
}

// Zählt, wie viele Einheiten überhaupt noch buzzern dürften
function activeUnitCount(room) {
  const units = new Set();
  for (const [sid, p] of Object.entries(room.players)) {
    if (!p.online) continue;
    units.add(buzzUnitId(room, sid));
  }
  return units.size;
}

// Punkte gutschreiben/abziehen — im Team-Modus aufs Team
function addScore(room, socketId, pts) {
  const p = room.players[socketId];
  if (!p) return;
  if (room.mode === 'teams' && p.teamId && room.teams[p.teamId]) {
    room.teams[p.teamId].score += pts;
  } else {
    p.score += pts;
  }
}

// Scoreboard-Einträge: im Team-Modus eine Zeile pro Team
function scoreboard(room) {
  if (room.mode === 'teams') {
    return Object.values(room.teams).map(t => ({
      id: t.id,
      name: t.name,
      score: t.score,
      color: t.color,
      isTeam: true,
      members: Object.values(room.players)
        .filter(p => p.teamId === t.id)
        .map(p => ({ name: p.name, online: p.online })),
      online: Object.values(room.players).some(p => p.teamId === t.id && p.online),
    }));
  }
  return Object.values(room.players).map(p => ({
    id: p.socketId,
    name: p.name,
    score: p.score,
    isTeam: false,
    online: p.online,
  }));
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
      name: p.name, score: p.score, socketId: p.socketId, online: p.online,
      teamId: p.teamId || null,
    })),
    mode: room.mode,
    teams: Object.values(room.teams).map(t => ({
      id: t.id, name: t.name, score: t.score, color: t.color,
      memberCount: Object.values(room.players).filter(p => p.teamId === t.id).length,
      members: Object.values(room.players)
        .filter(p => p.teamId === t.id)
        .map(p => ({ name: p.name, online: p.online })),
    })),
    scoreboard: scoreboard(room),
    maxLockouts: room.maxLockouts,
    lockedOutCount: room.lockedOut.size,
    activeQuestion: room.activeQuestion ? {
      categoryIdx: room.activeQuestion.categoryIdx,
      questionIdx: room.activeQuestion.questionIdx,
      value: activeQ(room)?.value,
      isDailyDouble: activeQ(room)?.isDailyDouble,
      mediaType: activeQ(room)?.mediaType,
      mediaUrl: activeQ(room)?.mediaUrl,
      question: room.questionRevealed ? activeQ(room)?.question : null,
    } : null,
    questionRevealed: !!room.questionRevealed,
    buzzerClosed: !!room.buzzerClosed,
    buzzer: room.buzzer ? unitLabel(room, room.buzzer) : null,
    buzzerTeamColor: room.buzzer ? teamColorOf(room, room.buzzer) : null,
    buzzOrder: room.buzzOrder.map(id => unitLabel(room, id)).filter(Boolean),
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

function teamColorOf(room, socketId) {
  const p = room.players[socketId];
  if (!p || room.mode !== 'teams' || !p.teamId) return null;
  return room.teams[p.teamId]?.color || null;
}

function gamemasterState(room) {
  const pub = roomPublicState(room);
  // GM sieht zusätzlich, WER konkret gebuzzert hat (Spieler sehen nur das Team)
  pub.buzzerPlayerName = room.buzzer ? room.players[room.buzzer]?.name || null : null;
  pub.buzzOrderPlayers = room.buzzOrder
    .map(id => room.players[id]?.name)
    .filter(Boolean);
  if (room.activeQuestion) {
    pub.activeQuestion = {
      ...pub.activeQuestion,
      question: activeQ(room)?.question,
      answer: activeQ(room)?.answer,
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
      room.buzzerClosed = true;
      broadcastRoom(room);
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
      // Solo-Modus: Lockout hing am Socket -> mitziehen. Team-Lockout bleibt bestehen.
      if (room.mode !== 'teams') room.lockedOut.delete(existing.socketId);
      socket.join(room.code);
      broadcastRoom(room);
      return cb({ ok: true, state: roomPublicState(room), playerId: socket.id, rejoined: true });
    }

    const nameTaken = Object.values(room.players).find(
      p => p.name.toLowerCase() === playerName.toLowerCase()
    );
    if (nameTaken) return cb({ error: 'Name bereits vergeben' });

    // Nachzügler dürfen auch im laufenden Spiel beitreten (wichtig bei großen Gruppen)
    room.players[socket.id] = { name: playerName, score: 0, socketId: socket.id, online: true, teamId: null };
    socket.join(room.code);
    broadcastRoom(room);
    cb({ ok: true, state: roomPublicState(room), playerId: socket.id });
  });

  // ─── TEAMS ─────────────────────────────────────────────────────────────────

  socket.on('gm:set_mode', ({ mode }, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    if (room.phase !== 'lobby') return cb?.({ error: 'Nur in der Lobby änderbar' });
    if (!['solo', 'teams'].includes(mode)) return cb?.({ error: 'Ungültiger Modus' });
    room.mode = mode;
    if (mode === 'solo') {
      // Team-Zuordnung lösen, Punkte bleiben beim Spieler
      Object.values(room.players).forEach(p => { p.teamId = null; });
    }
    broadcastRoom(room);
    cb?.({ ok: true });
  });

  socket.on('gm:set_max_lockouts', ({ value }, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    const v = parseInt(value, 10);
    if (isNaN(v) || v < 0 || v > 99) return cb?.({ error: 'Wert muss 0–99 sein' });
    room.maxLockouts = v;
    broadcastRoom(room);
    cb?.({ ok: true });
  });

  function createTeam(room, rawName) {
    const name = (rawName || '').trim().substring(0, 20);
    if (!name) return { error: 'Bitte Teamnamen eingeben' };
    const taken = Object.values(room.teams)
      .some(t => t.name.toLowerCase() === name.toLowerCase());
    if (taken) return { error: 'Teamname bereits vergeben' };
    const color = freeTeamColor(room);
    // Ohne freie Farbe kein weiteres Team: Farben muessen eindeutig bleiben
    if (!color) return { error: `Maximal ${TEAM_COLORS.length} Teams` };
    const id = uuidv4().slice(0, 8);
    room.teams[id] = { id, name, score: 0, color };
    return { team: room.teams[id] };
  }

  socket.on('gm:create_team', ({ name }, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    const r = createTeam(room, name);
    if (r.error) return cb?.({ error: r.error });
    broadcastRoom(room);
    cb?.({ ok: true, team: r.team });
  });

  socket.on('gm:delete_team', ({ teamId }, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    if (!room.teams[teamId]) return cb?.({ error: 'Team nicht gefunden' });
    Object.values(room.players).forEach(p => {
      if (p.teamId === teamId) p.teamId = null;
    });
    delete room.teams[teamId];
    broadcastRoom(room);
    cb?.({ ok: true });
  });

  // Spieler erstellt selbst ein Team (Lobby)
  socket.on('player:create_team', ({ name }, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || !room.players[socket.id]) return cb?.({ error: 'Nicht im Spiel' });
    if (room.mode !== 'teams') return cb?.({ error: 'Kein Team-Modus' });
    if (room.phase !== 'lobby') return cb?.({ error: 'Spiel läuft bereits' });
    const r = createTeam(room, name);
    if (r.error) return cb?.({ error: r.error });
    room.players[socket.id].teamId = r.team.id;
    broadcastRoom(room);
    cb?.({ ok: true, teamId: r.team.id });
  });

  socket.on('player:join_team', ({ teamId }, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || !room.players[socket.id]) return cb?.({ error: 'Nicht im Spiel' });
    if (room.mode !== 'teams') return cb?.({ error: 'Kein Team-Modus' });
    if (room.phase !== 'lobby') return cb?.({ error: 'Spiel läuft bereits' });
    if (!room.teams[teamId]) return cb?.({ error: 'Team nicht gefunden' });
    room.players[socket.id].teamId = teamId;
    broadcastRoom(room);
    cb?.({ ok: true, teamId });
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
    if (room.mode === 'teams') {
      const teamCount = Object.keys(room.teams).length;
      if (teamCount < 1) return cb?.({ error: 'Mindestens ein Team anlegen' });
      const homeless = Object.values(room.players).filter(p => !p.teamId);
      if (homeless.length > 0) {
        return cb?.({ error: `Ohne Team: ${homeless.map(p => p.name).join(', ')}` });
      }
    }
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
    room.questionRevealed = true;
    room.buzzerClosed = false;
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
  socket.on('gm:set_score', ({ socketId, teamId, score }, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    // Im Team-Modus wird der Team-Score bearbeitet
    if (teamId || room.mode === 'teams') {
      const tid = teamId || room.players[socketId]?.teamId;
      const team = room.teams[tid];
      if (!team) return cb?.({ error: 'Team nicht gefunden' });
      const p2 = parseInt(score);
      if (isNaN(p2)) return cb?.({ error: 'Ungültiger Wert' });
      team.score = p2;
      broadcastRoom(room);
      return cb?.({ ok: true });
    }
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
    // Jeder Pfad MUSS den Callback bedienen, sonst haengt der Buzzer-Button
    // auf dem Handy (bei 20 Spielern betrifft das alle ausser dem Ersten).
    if (!room || !room.players[socket.id]) return cb?.({ error: 'Nicht im Spiel' });
    if (room.phase === 'buzzed') {
      // Jemand war schneller — Reihenfolge trotzdem festhalten
      const u = buzzUnitId(room, socket.id);
      if (!room.lockedOut.has(u) && !room.buzzOrder.includes(socket.id)) {
        room.buzzOrder.push(socket.id);
        broadcastRoom(room);
      }
      return cb?.({ ok: true, tooLate: true });
    }
    if (room.phase !== 'question') return cb?.({ error: 'Gerade läuft keine Frage' });
    if (room.buzzerClosed) return cb?.({ error: 'Buzzer ist gesperrt' });
    const unit = buzzUnitId(room, socket.id);
    // maxLockouts = 0 -> unbegrenzt
    if (room.maxLockouts > 0 && room.lockedOut.size >= room.maxLockouts) {
      return cb?.({ error: 'Maximale Buzzer-Versuche erreicht' });
    }
    if (room.lockedOut.has(unit)) {
      return cb?.({ error: room.mode === 'teams' ? 'Dein Team ist gesperrt' : 'Du bist gesperrt' });
    }
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
      addScore(room, buzzerId, pts);
      q.answered = true;
      room.phase = 'board';
      room.activeQuestion = null;
      room.buzzer = null;
      room.buzzOrder = [];
      room.lockedOut = new Set();
      room.questionRevealed = false;
      room.buzzerClosed = false;
      clearRoomTimer(room);
      room.timer = null;
    } else {
      addScore(room, buzzerId, -pts);
      room.lockedOut.add(buzzUnitId(room, buzzerId));
      room.buzzer = null;
      room.phase = 'question';
      const limitHit = room.maxLockouts > 0 && room.lockedOut.size >= room.maxLockouts;
      room.buzzerClosed = limitHit || room.lockedOut.size >= activeUnitCount(room);
    }
    broadcastRoom(room);
    // Explizites Urteil fuer die Anzeige — zuverlaessiger als ein
    // Vergleich der Punktesumme auf Client-Seite.
    io.to(room.code).emit('judge:result', {
      correct: !!correct,
      unit: unitLabel(room, buzzerId),
      color: teamColorOf(room, buzzerId),
      points: correct ? pts : -pts,
    });
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
    clearRoomTimer(room);
    room.timer = null;
    broadcastRoom(room);
    cb?.({ ok: true });
  });

  // 3-2-1-Countdown vor Buzzer-Freigabe (Spannung + verhindert Vorab-Spam)
  socket.on('gm:buzz_countdown', (_, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.gamemasterId !== socket.id) return;
    if (!['question', 'buzzed'].includes(room.phase)) return;
    room.buzzerClosed = true;
    broadcastRoom(room);
    let n = 3;
    io.to(room.code).emit('buzz:countdown', { n });
    const iv = setInterval(() => {
      n--;
      if (n > 0) {
        io.to(room.code).emit('buzz:countdown', { n });
      } else {
        clearInterval(iv);
        if (rooms[room.code]) {
          room.buzzerClosed = false;
          io.to(room.code).emit('buzz:countdown', { n: 0 });
          broadcastRoom(room);
        }
      }
    }, 1000);
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
        room.lockedOut.add(buzzUnitId(room, socket.id));
        const activePlayers = Object.keys(room.players).filter(
          id => room.players[id].online && !room.lockedOut.has(buzzUnitId(room, id))
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
