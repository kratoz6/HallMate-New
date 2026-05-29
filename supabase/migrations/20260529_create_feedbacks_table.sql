-- HallMate / Zenter — Feedback storage table.
-- Run this in Supabase SQL Editor before deploying the feedback modal.

CREATE TABLE IF NOT EXISTS feedbacks (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        REFERENCES users(id) ON DELETE SET NULL,
  user_name        TEXT,
  exam_type        TEXT,
  feedback_message TEXT        NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE feedbacks ENABLE ROW LEVEL SECURITY;

-- Allow any authenticated or anonymous user to INSERT feedback.
-- No SELECT/UPDATE/DELETE needed from the browser.
CREATE POLICY "Public feedback insert"
  ON feedbacks FOR INSERT TO public WITH CHECK (true);
