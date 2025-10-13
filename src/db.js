// src/db.js
// ------------------------------------------
// MySQL database connection and operations
// Safe for repeated ANT-Capsulizer runs
// ------------------------------------------
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  connectionLimit: 10,
});

// -----------------------------------------------------
// Upsert or fetch existing node (owner_slug + domain)
// -----------------------------------------------------
async function upsertNode(owner_slug, source_url) {
  const domain = new URL(source_url).hostname;

  // Insert or update existing node (unique by owner_slug + domain)
  const [res] = await pool.query(
    `
    INSERT INTO nodes (owner_slug, source_url)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE
      source_url = VALUES(source_url),
      last_harvested = NOW()
    `,
    [owner_slug, source_url]
  );

  // MySQL returns 0 for affected rows if duplicate update
  // Retrieve id either from insertId or existing row
  if (res.insertId && res.insertId > 0) return res.insertId;

  const [rows] = await pool.query(
    "SELECT id FROM nodes WHERE owner_slug = ? AND domain = ? LIMIT 1",
    [owner_slug, domain]
  );
  return rows[0]?.id || null;
}

// -----------------------------------------------------
// Insert or overwrite capsule (unique by node + fp)
// -----------------------------------------------------
async function insertCapsule(
  node_id,
  capsule_json,
  fingerprint,
  harvested_at,
  status = "ok"
) {
  // Convert ISO timestamp to MySQL DATETIME (no Z, no ms)
  const formatted = harvested_at
    .replace("T", " ")
    .replace("Z", "")
    .split(".")[0];

  await pool.query(
    `
    INSERT INTO capsules (node_id, fingerprint, capsule_json, harvested_at, status)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      capsule_json = VALUES(capsule_json),
      harvested_at = VALUES(harvested_at),
      status = VALUES(status),
      updated_at = NOW()
    `,
    [node_id, fingerprint, JSON.stringify(capsule_json), formatted, status]
  );
}

// -----------------------------------------------------
// Optional helper: run arbitrary read query
// -----------------------------------------------------
async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

// -----------------------------------------------------
// Exports
// -----------------------------------------------------
module.exports = {
  pool,
  upsertNode,
  insertCapsule,
  query,
};
