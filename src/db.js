const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  connectionLimit: 10
});

async function upsertNode(owner_slug, source_url) {
  const [res] = await pool.query(
    'INSERT INTO nodes (owner_slug, source_url) VALUES (?, ?)',
    [owner_slug, source_url]
  );
  return res.insertId;
}

async function insertCapsule(node_id, capsule_json, fingerprint, harvested_at, status = 'ok') {
  // Convert ISO timestamp to MySQL DATETIME (no 'Z')
  const formatted = harvested_at.replace('T', ' ').replace('Z', '').split('.')[0];
  await pool.query(
    'INSERT INTO capsules (node_id, capsule_json, fingerprint, harvested_at, status) VALUES (?,?,?,?,?)',
    [node_id, JSON.stringify(capsule_json), fingerprint, formatted, status]
  );
}


module.exports = {
  pool,
  upsertNode,
  insertCapsule
};
