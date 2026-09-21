-- per-terminal display money unit (manual; not overwritten by EA currency)
ALTER TABLE terminals ADD COLUMN display_unit TEXT DEFAULT '';
