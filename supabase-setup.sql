-- ═══════════════════════════════════════════════════════════════════════════
-- Jeopardy — Supabase Setup
-- Einmalig im Supabase SQL-Editor des NEUEN Projekts ausführen.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Benutzer (eigene Tabelle, kein Supabase Auth) ─────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY,
  username      text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz DEFAULT now()
);

-- Login nutzt .ilike() auf username -> case-insensitiver Index
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx
  ON users (lower(username));

-- ─── Quizze ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quizzes (
  id         uuid PRIMARY KEY,
  title      text NOT NULL DEFAULT 'Neues Quiz',
  categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);

-- /api/quizzes filtert nach user_id und sortiert nach created_at
CREATE INDEX IF NOT EXISTS quizzes_user_id_idx    ON quizzes (user_id);
CREATE INDEX IF NOT EXISTS quizzes_created_at_idx ON quizzes (created_at DESC);

-- ─── Row Level Security ────────────────────────────────────────────────────
-- Der Server nutzt den service_role-Key (umgeht RLS). RLS wird aktiviert,
-- damit der anon-Key ohne eigene Policies KEINEN Zugriff hat.
ALTER TABLE users   ENABLE ROW LEVEL SECURITY;
ALTER TABLE quizzes ENABLE ROW LEVEL SECURITY;

-- ─── Storage-Bucket für Medien (Bilder/Videos) ─────────────────────────────
-- Public, weil der Server getPublicUrl() nutzt und die URLs direkt
-- in <img>/<video> der Clients landen.
INSERT INTO storage.buckets (id, name, public)
VALUES ('media', 'media', true)
ON CONFLICT (id) DO UPDATE SET public = true;
