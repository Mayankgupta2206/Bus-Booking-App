const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'seva.db');
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');

async function runBackup() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}`);
    process.exit(1);
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const backupFileName = `seva-backup-${timestamp}.db`;
  const backupPath = path.join(BACKUP_DIR, backupFileName);

  console.log(`Starting backup of ${DB_PATH}...`);
  const db = new Database(DB_PATH);
  
  try {
    await db.backup(backupPath);
    const stats = fs.statSync(backupPath);
    console.log(`Backup completed successfully!`);
    console.log(`File: ${backupPath} (${(stats.size / 1024).toFixed(1)} KB)`);
    return { fileName: backupFileName, path: backupPath, size: stats.size, createdAt: now.toISOString() };
  } catch (err) {
    console.error(`Backup failed:`, err);
    throw err;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  runBackup().catch(() => process.exit(1));
}

module.exports = { runBackup, BACKUP_DIR };
