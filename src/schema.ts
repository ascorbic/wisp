/** Run all schema migrations. Called in agent constructor. */
export function migrate(sql: TemplateLiteralSQL) {
	sql`CREATE TABLE IF NOT EXISTS users (
		did TEXT PRIMARY KEY,
		handle TEXT,
		profile TEXT,
		tier TEXT,
		interaction_count INTEGER DEFAULT 0,
		first_seen INTEGER,
		last_seen INTEGER
	)`;

	sql`CREATE TABLE IF NOT EXISTS interactions (
		id INTEGER PRIMARY KEY,
		user_did TEXT REFERENCES users(did),
		direction TEXT,
		type TEXT,
		uri TEXT,
		summary TEXT,
		created_at INTEGER
	)`;

	sql`CREATE TABLE IF NOT EXISTS journal (
		id INTEGER PRIMARY KEY,
		topic TEXT,
		content TEXT,
		created_at INTEGER
	)`;

	sql`CREATE TABLE IF NOT EXISTS tracked_threads (
		rootUri TEXT PRIMARY KEY,
		lastActivity INTEGER
	)`;

	// FTS5 virtual tables for search
	sql`CREATE VIRTUAL TABLE IF NOT EXISTS users_fts USING fts5(
		handle, profile, content=users, content_rowid=rowid
	)`;

	sql`CREATE VIRTUAL TABLE IF NOT EXISTS journal_fts USING fts5(
		topic, content, content=journal, content_rowid=rowid
	)`;

	// Triggers to keep FTS in sync
	sql`CREATE TRIGGER IF NOT EXISTS users_ai AFTER INSERT ON users BEGIN
		INSERT INTO users_fts(rowid, handle, profile) VALUES (new.rowid, new.handle, new.profile);
	END`;

	sql`CREATE TRIGGER IF NOT EXISTS users_au AFTER UPDATE ON users BEGIN
		INSERT INTO users_fts(users_fts, rowid, handle, profile) VALUES ('delete', old.rowid, old.handle, old.profile);
		INSERT INTO users_fts(rowid, handle, profile) VALUES (new.rowid, new.handle, new.profile);
	END`;

	sql`CREATE TRIGGER IF NOT EXISTS users_ad AFTER DELETE ON users BEGIN
		INSERT INTO users_fts(users_fts, rowid, handle, profile) VALUES ('delete', old.rowid, old.handle, old.profile);
	END`;

	sql`CREATE TRIGGER IF NOT EXISTS journal_ai AFTER INSERT ON journal BEGIN
		INSERT INTO journal_fts(rowid, topic, content) VALUES (new.rowid, new.topic, new.content);
	END`;

	sql`CREATE TRIGGER IF NOT EXISTS journal_ad AFTER DELETE ON journal BEGIN
		INSERT INTO journal_fts(journal_fts, rowid, topic, content) VALUES ('delete', old.rowid, old.topic, old.content);
	END`;
}

/** Tagged template SQL type matching the Agents SDK. */
type TemplateLiteralSQL = {
	<T = Record<string, string | number | boolean | null>>(
		strings: TemplateStringsArray,
		...values: (string | number | boolean | null)[]
	): T[];
};
