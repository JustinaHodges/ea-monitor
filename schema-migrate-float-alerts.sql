-- per-terminal floating PnL alert thresholds
ALTER TABLE terminals ADD COLUMN float_profit_alert REAL DEFAULT 0;
ALTER TABLE terminals ADD COLUMN float_loss_alert REAL DEFAULT 0;
ALTER TABLE terminals ADD COLUMN float_profit_latched INTEGER DEFAULT 0;
ALTER TABLE terminals ADD COLUMN float_loss_latched INTEGER DEFAULT 0;
