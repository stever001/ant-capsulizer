-- ===========================================
-- ANT-CAPSULIZER DATABASE SCHEMA (MySQL 8.x)
-- UPDATED: +node_category (for intelligent recrawl scheduling)
-- ===========================================

DROP TRIGGER IF EXISTS trg_update_last_harvested;

CREATE TABLE IF NOT EXISTS nodes (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  owner_slug VARCHAR(255) NOT NULL,
  source_url TEXT NOT NULL,
  domain VARCHAR(255)
    GENERATED ALWAYS AS (SUBSTRING_INDEX(SUBSTRING_INDEX(source_url, '/', 3), '//', -1)) STORED,
  node_category ENUM('ecommerce','media','smb','corporate','landing') DEFAULT 'smb', -- ✅ new
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  last_harvested DATETIME NULL
);

CREATE TABLE IF NOT EXISTS capsules (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  node_id BIGINT NOT NULL,
  capsule_json JSON NOT NULL,
  fingerprint VARCHAR(80) NOT NULL,
  harvested_at DATETIME NOT NULL,
  status ENUM('ok','needs_review','error') DEFAULT 'ok',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

-- Drop/recreate indexes safely
DROP INDEX idx_capsules_fp ON capsules;
DROP INDEX idx_nodes_domain ON nodes;
DROP INDEX uniq_owner_domain ON nodes;

CREATE INDEX idx_capsules_fp ON capsules(fingerprint);
CREATE INDEX idx_nodes_domain ON nodes(domain);
CREATE UNIQUE INDEX uniq_owner_domain ON nodes(owner_slug, domain);

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
