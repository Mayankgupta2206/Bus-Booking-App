const jwt = require('jsonwebtoken');
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
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

function requireAgentOrAdmin(req, res, next) {
  if (req.user.role !== 'Admin' && req.user.role !== 'Agent') {
    return res.status(403).json({ error: 'Booking access requires Agent or Admin role.' });
  }
  next();
}

function requireAdminOrSupervisor(req, res, next) {
  if (req.user.role !== 'Admin' && req.user.role !== 'Supervisor') {
    return res.status(403).json({ error: 'Admin or Supervisor access required.' });
  }
  next();
}

module.exports = { signToken, requireAuth, requireAdmin, requireAgentOrAdmin, requireAdminOrSupervisor };
