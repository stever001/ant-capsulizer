-- ===========================================
-- ANT-CAPSULIZER DATABASE SCHEMA (MySQL 8.x)
-- Fully idempotent: safe to re-run
-- ===========================================

-- Drop trigger if it already exists
DROP TRIGGER IF EXISTS trg_update_last_harvested;

-- ----------------------------
-- Tables
-- ----------------------------
CREATE TABLE IF NOT EXISTS nodes (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  owner_slug VARCHAR(255) NOT NULL,
  source_url TEXT NOT NULL,
  domain VARCHAR(255)
    GENERATED ALWAYS AS (SUBSTRING_INDEX(SUBSTRING_INDEX(source_url, '/', 3), '//', -1)) STORED,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  last_harvested DATETIME NULL,
  last_inferred_at DATETIME NULL
);

CREATE TABLE IF NOT EXISTS capsules (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  node_id BIGINT NOT NULL,
  capsule_json JSON NOT NULL,
  fingerprint VARCHAR(80) NOT NULL,
  harvested_at DATETIME NOT NULL,
  inferred_at DATETIME NULL,
  status ENUM('ok','needs_review','error') DEFAULT 'ok',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

-- ----------------------------
-- Indexes (drop safely before re-create)
-- ----------------------------
-- Capsules fingerprint index
SET @has_idx_capsules_fp := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'capsules'
    AND index_name = 'idx_capsules_fp'
);
SET @sql := IF(@has_idx_capsules_fp > 0,
  'DROP INDEX idx_capsules_fp ON capsules;',
  'SELECT "skip";'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Nodes domain index
SET @has_idx_nodes_domain := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'nodes'
    AND index_name = 'idx_nodes_domain'
);
SET @sql := IF(@has_idx_nodes_domain > 0,
  'DROP INDEX idx_nodes_domain ON nodes;',
  'SELECT "skip";'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Recreate indexes
CREATE INDEX idx_capsules_fp ON capsules(fingerprint);
CREATE INDEX idx_nodes_domain ON nodes(domain);

-- ----------------------------
-- Trigger: update nodes.last_harvested after capsule insert
-- ----------------------------
DELIMITER $$

CREATE TRIGGER trg_update_last_harvested
AFTER INSERT ON capsules
FOR EACH ROW
BEGIN
  UPDATE nodes
  SET last_harvested = NEW.harvested_at
  WHERE id = NEW.node_id;
END$$

DELIMITER ;

-- ===========================================
-- END OF SCHEMA
-- ===========================================
