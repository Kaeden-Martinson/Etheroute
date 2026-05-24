const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// Simple password hashing (in production, use bcrypt)
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function verifyPassword(password, hash) {
  return hashPassword(password) === hash;
}

// Simple JWT generation (in production, use jsonwebtoken)
function generateToken(clientId, username) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64');
  const payload = Buffer.from(JSON.stringify({ 
    clientId, 
    username,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60) // 30 days
  })).toString('base64');
  
  const signature = crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'your-secret-key')
    .update(`${header}.${payload}`)
    .digest('base64');

  return `${header}.${payload}.${signature}`;
}

function verifyToken(token) {
  try {
    const [header, payload, signature] = token.split('.');
    
    const expectedSignature = crypto
      .createHmac('sha256', process.env.JWT_SECRET || 'your-secret-key')
      .update(`${header}.${payload}`)
      .digest('base64');

    if (signature !== expectedSignature) {
      return null;
    }

    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
    
    if (decoded.exp < Math.floor(Date.now() / 1000)) {
      return null; // Token expired
    }

    return decoded;
  } catch (error) {
    return null;
  }
}

class AuthService {
  static register(db, userData) {
    const { username, password } = userData;

    // Check if username already exists
    if (db.findOneBy('users', { username })) {
      throw new Error('Username already taken');
    }

    // Create new user
    const user = {
      id: uuidv4(),
      username,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString()
    };

    db.create('users', user);

    // Generate token
    const token = generateToken(user.id, username);

    return {
      token,
      clientId: user.id,
      username: user.username,
    };
  }

  static login(db, credentials) {
    const { username, password } = credentials;

    const user = db.findOneBy('users', { username });
    if (!user) {
      throw new Error('Invalid username or password');
    }

    if (!verifyPassword(password, user.passwordHash)) {
      throw new Error('Invalid username or password');
    }

    // Update last login
    user.lastLogin = new Date().toISOString();
    db.update('users', user.id, user);

    // Generate token
    const token = generateToken(user.id, user.username);

    return {
      token,
      clientId: user.id,
      username: user.username,
    };
  }

  static verifyTokenMiddleware(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.user = decoded;
    next();
  }
}

module.exports = AuthService;
