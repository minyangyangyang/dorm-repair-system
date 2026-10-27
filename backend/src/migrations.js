// Additive V2 migration: never rebuild or backfill legacy business tables.
export function migrateDatabase(db) {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `)
    if (!db.prepare('SELECT version FROM schema_migrations WHERE version = 1').get()) {
      db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_hash TEXT NOT NULL,
          display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 50),
          role TEXT NOT NULL CHECK(role IN ('student', 'worker', 'admin')),
          is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
          created_at TEXT NOT NULL
        );
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `)
      const columns = new Set(db.prepare('PRAGMA table_info(repair_orders)').all().map(column => column.name))
      if (!columns.has('student_id')) db.exec('ALTER TABLE repair_orders ADD COLUMN student_id INTEGER REFERENCES users(id)')
      if (!columns.has('assigned_worker_id')) db.exec('ALTER TABLE repair_orders ADD COLUMN assigned_worker_id INTEGER REFERENCES users(id)')
      db.exec(`
        CREATE INDEX idx_repairs_student ON repair_orders(student_id);
        CREATE INDEX idx_repairs_worker_status ON repair_orders(assigned_worker_id, status);
        CREATE INDEX idx_sessions_user ON sessions(user_id);
        CREATE INDEX idx_sessions_expires ON sessions(expires_at);
      `)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(new Date().toISOString())
    }

    if (!db.prepare('SELECT version FROM schema_migrations WHERE version = 2').get()) {
      db.exec(`
        CREATE TABLE repair_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repair_order_id INTEGER NOT NULL REFERENCES repair_orders(id),
          event_type TEXT NOT NULL CHECK(event_type IN ('created', 'accepted', 'assigned', 'reassigned', 'started', 'completed')),
          actor_id INTEGER NOT NULL REFERENCES users(id),
          actor_display_name TEXT NOT NULL,
          actor_role TEXT NOT NULL CHECK(actor_role IN ('student', 'worker', 'admin')),
          occurred_at TEXT NOT NULL,
          from_status TEXT CHECK(from_status IN ('待处理', '已接单', '维修中', '已完成')),
          to_status TEXT NOT NULL CHECK(to_status IN ('待处理', '已接单', '维修中', '已完成')),
          from_worker_id INTEGER REFERENCES users(id),
          to_worker_id INTEGER REFERENCES users(id)
        );
        CREATE INDEX idx_repair_logs_order_time ON repair_logs(repair_order_id, occurred_at, id);
        CREATE TRIGGER repair_logs_no_update BEFORE UPDATE ON repair_logs
          BEGIN SELECT RAISE(ABORT, 'repair logs are append-only'); END;
        CREATE TRIGGER repair_logs_no_delete BEFORE DELETE ON repair_logs
          BEGIN SELECT RAISE(ABORT, 'repair logs are append-only'); END;
      `)
      // Do not infer or backfill events for existing orders.
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)').run(new Date().toISOString())
    }

    if (!db.prepare('SELECT version FROM schema_migrations WHERE version = 3').get()) {
      db.exec(`
        CREATE TABLE notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recipient_id INTEGER NOT NULL REFERENCES users(id),
          event_type TEXT NOT NULL CHECK(event_type IN ('created', 'accepted', 'assigned', 'reassigned', 'started', 'completed')),
          repair_order_id INTEGER NOT NULL REFERENCES repair_orders(id),
          source_log_id INTEGER NOT NULL REFERENCES repair_logs(id),
          title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 100),
          content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 500),
          created_at TEXT NOT NULL,
          read_at TEXT,
          UNIQUE(recipient_id, source_log_id)
        );
        CREATE INDEX idx_notifications_recipient_time ON notifications(recipient_id, created_at DESC, id DESC);
        CREATE INDEX idx_notifications_unread_time ON notifications(recipient_id, created_at DESC, id DESC) WHERE read_at IS NULL;
      `)
      // Existing logs and historical orders are intentionally not replayed.
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)').run(new Date().toISOString())
    }
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}
