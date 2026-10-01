const jwt = require('jsonwebtoken');
const db = require('./db');
const { parseUserPermissions } = db.helpers;

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, name: user.name, role: user.role },
    SECRET,
    { expiresIn: '12h' }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    const payload = jwt.verify(token, SECRET);
    const dbUser = db.prepare('SELECT id, username, name, role, permissions FROM users WHERE id = ?').get(payload.id);
    if (!dbUser) {
      return res.status(401).json({ error: 'User account not found or removed.' });
    }
    req.user = {
      id: dbUser.id,
      username: dbUser.username,
      name: dbUser.name,
      role: dbUser.role,
      permissions: parseUserPermissions(dbUser)
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

function requirePerm(permKey) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
    if (req.user.role === 'Admin') return next();
    if (req.user.permissions && req.user.permissions[permKey]) {
      return next();
    }
    return res.status(403).json({ error: `Permission denied: Missing '${permKey}' power.` });
  };
}

function requireAgentOrAdmin(req, res, next) {
  if (req.user.role === 'Admin' || (req.user.permissions && req.user.permissions.can_book)) {
    return next();
  }
  return res.status(403).json({ error: 'Booking access requires booking permission.' });
}

function requireAdminOrSupervisor(req, res, next) {
  if (req.user.role === 'Admin' || req.user.role === 'Supervisor' || (req.user.permissions && (req.user.permissions.can_manifest || req.user.permissions.can_view_logs))) {
    return next();
  }
  return res.status(403).json({ error: 'Elevated staff access required.' });
}

module.exports = {
  signToken,
  requireAuth,
  requireAdmin,
  requirePerm,
  requireAgentOrAdmin,
  requireAdminOrSupervisor
};
