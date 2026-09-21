-- share link visibility options
ALTER TABLE share_links ADD COLUMN show_calendar INTEGER NOT NULL DEFAULT 1;
ALTER TABLE share_links ADD COLUMN show_books INTEGER NOT NULL DEFAULT 1;
