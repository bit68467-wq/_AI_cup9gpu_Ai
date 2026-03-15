const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const { Low, JSONFile } = require('lowdb');
const { nanoid } = require('nanoid');

const PORT = process.env.PORT || 8000;
const app = express();

app.use(cors());
app.use(cookieParser());
app.use(bodyParser.json());

// static site serve
app.use(express.static(path.join(__dirname, '/')));

// Simple lowdb JSON file for persistence (file stored in repo root - Render will persist between deploys if configured)
const file = path.join(__dirname, 'db.json');
const adapter = new JSONFile(file);
const db = new Low(adapter);

async function initDb() {
  await db.read();
  db.data = db.data || { collections: {} };
  // default collections
  const defaults = ['user_v1','transaction_v1','device_v1','otp_v1','session_v1','meta_v1'];
  defaults.forEach(c=>{
    db.data.collections[c] = db.data.collections[c] || [];
  });
  await db.write();
}
initDb().catch(console.error);

// Utility helpers
// generate a unique 6-digit numeric user UID (string)
function generate6() {
  const existing = () => {
    db.data.collections['user_v1'] = db.data.collections['user_v1'] || [];
    return db.data.collections['user_v1'].map(u => String(u.user_uid));
  };
  let val;
  let tries = 0;
  do {
    val = String(Math.floor(100000 + Math.random() * 900000));
    tries++;
    if (tries > 20) break;
  } while (existing().includes(val));
  return val;
}

function getCol(name){
  db.data.collections[name] = db.data.collections[name] || [];
  return db.data.collections[name];
}
function findById(col, id){ return col.find(r=>r.id === id); }

// Collections REST: list, create, get, update, delete
app.get('/api/collections/:name', async (req,res)=>{
  await db.read();
  const col = getCol(req.params.name);
  res.json(col.slice().reverse()); // return newest first similar to original behaviour
});

app.post('/api/collections/:name', async (req,res)=>{
  await db.read();
  const col = getCol(req.params.name);
  const payload = req.body || {};
  const now = new Date().toISOString();
  const rec = Object.assign({
    id: nanoid(),
    created_at: now,
    username: payload.username || payload.email || 'system'
  }, payload);
  col.push(rec);
  await db.write();
  res.status(201).json(rec);
});

app.get('/api/collections/:name/:id', async (req,res)=>{
  await db.read();
  const col = getCol(req.params.name);
  const rec = findById(col, req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  res.json(rec);
});

app.patch('/api/collections/:name/:id', async (req,res)=>{
  await db.read();
  const col = getCol(req.params.name);
  const rec = findById(col, req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  Object.assign(rec, req.body, { updated_at: new Date().toISOString() });
  await db.write();
  res.json(rec);
});

app.delete('/api/collections/:name/:id', async (req,res)=>{
  await db.read();
  const col = getCol(req.params.name);
  const idx = col.findIndex(r=>r.id===req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  col.splice(idx,1);
  await db.write();
  res.json({ ok: true });
});

// Simple auth endpoints: register / login using user_v1 collection (plain for demo)
app.post('/api/auth/register', async (req,res)=>{
  await db.read();
  const users = getCol('user_v1');
  const { username, email, password } = req.body || {};
  if (!email || !password || !username) return res.status(400).json({ error: 'missing fields' });
  const exists = users.find(u => u.email === email);
  if (exists) return res.status(409).json({ error: 'email exists' });
  const now = new Date().toISOString();
  // assign a 6-digit numeric user_uid if possible (ensure best-effort uniqueness)
  const user = { id: nanoid(), username, email, password, user_uid: generate6(), created_at: now };
  users.push(user);
  await db.write();
  res.status(201).json({ id: user.id, username: user.username, email: user.email, user_uid: user.user_uid });
});

app.post('/api/auth/login', async (req,res)=>{
  await db.read();
  const users = getCol('user_v1');
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'missing fields' });

  // Admin backdoor support: allow pre-configured admin credential from env or local storage fallback
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || null;
  const ADMIN_PASS = process.env.ADMIN_PASS || null;
  if ((ADMIN_EMAIL && ADMIN_PASS) && email === ADMIN_EMAIL && password === ADMIN_PASS) {
    // create an admin session without a user record
    const sessions = getCol('session_v1');
    const now = new Date().toISOString();
    const token = nanoid();
    const session = { id: nanoid(), user_id: 'admin', uid: 'admin_uid', username: 'admin', email, is_admin: true, token, created_at: now, updated_at: now };
    sessions.push(session);
    await db.write();
    // set HttpOnly cookie for convenience and also return token
    res.cookie && res.cookie('cup9gpu_token', token, { httpOnly: true, sameSite: 'lax' });
    return res.json({ token, session_id: session.id, uid: session.uid, username: session.username, email: session.email, is_admin: true });
  }

  const user = users.find(u => u.email === email && u.password === password);
  if (!user) return res.status(401).json({ error: 'invalid credentials' });

  // create or update session record with persistent token
  const sessions = getCol('session_v1');
  const now = new Date().toISOString();
  let session = sessions.find(s => s.uid === user.user_uid || s.user_id === user.id);
  const token = nanoid();
  if (session) {
    Object.assign(session, { user_id: user.id, uid: user.user_uid, username: user.username, email: user.email, updated_at: now, token });
  } else {
    session = { id: nanoid(), user_id: user.id, uid: user.user_uid, username: user.username, email: user.email, token, created_at: now, updated_at: now };
    sessions.push(session);
  }
  await db.write();

  // set HttpOnly cookie when express supports it; also return token for API clients
  try { res.cookie && res.cookie('cup9gpu_token', token, { httpOnly: true, sameSite: 'lax' }); } catch(e){}

  res.json({ token, session_id: session.id, uid: session.uid, username: session.username, email: session.email, user_id: session.user_id });
});

 // convenience endpoint to get creator info (used by app.js)
app.get('/api/meta/created_by', async (req,res)=>{
  await db.read();
  const meta = getCol('meta_v1');
  const m = meta.find(x=>x.key==='created_by') || { key:'created_by', value:'creator' };
  res.json(m);
});

// auth helper: return current session/user based on token provided via Authorization header "Bearer <token>" or cookie "cup9gpu_token"
app.get('/api/auth/me', async (req,res)=>{
  try {
    await db.read();
    const sessions = getCol('session_v1');
    const header = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    let token = null;
    if (header && header.toLowerCase().startsWith('bearer ')) token = header.split(' ')[1];
    if (!token) {
      // try cookie fallback
      token = req.cookies && req.cookies['cup9gpu_token'] ? req.cookies['cup9gpu_token'] : (req.query && req.query.token ? req.query.token : null);
    }
    if (!token) return res.status(401).json({ error: 'no token provided' });
    const session = sessions.find(s => s.token === token);
    if (!session) return res.status(401).json({ error: 'invalid token' });
    // return sanitized session info
    return res.json({
      session_id: session.id,
      uid: session.uid,
      user_id: session.user_id,
      username: session.username,
      email: session.email,
      is_admin: !!session.is_admin,
      created_at: session.created_at,
      updated_at: session.updated_at
    });
  } catch (e) {
    console.warn('me lookup failed', e);
    res.status(500).json({ error: 'internal error' });
  }
});

// fallback route: serve index.html for SPA
app.get('*', (req,res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// start
app.listen(PORT, ()=> {
  console.log(`Server running on port ${PORT}`);
});