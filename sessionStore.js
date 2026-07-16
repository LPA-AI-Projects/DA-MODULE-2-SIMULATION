const META_KEY = 'simulation:session:meta';
const PARTICIPANTS_KEY = 'simulation:session:participants';
const SESSION_TTL_SECONDS = 86400;

const DEFAULT_META = { status: 'waiting', startedAt: null };

let redisClient = null;
let usingRedis = false;
let resolvedRedisUrl = null;
let lastRedisError = null;

const memoryMeta = { ...DEFAULT_META };
const memoryParticipants = new Map();

function participantForStorage(participant) {
  const { socketId, ...rest } = participant;
  return rest;
}

function looksLikeValidRedisUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed || trimmed.includes('undefined') || trimmed.includes('null')) return false;
  if (trimmed === 'redis://:@' || trimmed.startsWith('redis://:@')) return false;
  try {
    const parsed = new URL(trimmed);
    if (!['redis:', 'rediss:'].includes(parsed.protocol)) return false;
    if (!parsed.hostname) return false;
    return true;
  } catch {
    return false;
  }
}

function redactUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(invalid)';
  }
}

/**
 * Resolve Redis URL from Railway / common env vars.
 */
function resolveRedisUrl() {
  const candidates = [
    process.env.REDIS_URL,
    process.env.REDIS_PRIVATE_URL,
    process.env.REDIS_PUBLIC_URL,
    process.env.REDISCONNECTIONSTRING
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (looksLikeValidRedisUrl(candidate)) return candidate.trim();
  }

  const host = process.env.REDISHOST || process.env.REDIS_HOST || process.env.RAILWAY_TCP_PROXY_DOMAIN;
  const port = process.env.REDISPORT || process.env.REDIS_PORT || process.env.RAILWAY_TCP_PROXY_PORT || '6379';
  const password = process.env.REDISPASSWORD || process.env.REDIS_PASSWORD;
  const user = process.env.REDISUSER || process.env.REDIS_USER || 'default';

  if (host && password && !String(password).includes('undefined')) {
    const built = `redis://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}`;
    if (looksLikeValidRedisUrl(built)) return built;
  }

  if (host && !password) {
    const built = `redis://${host}:${port}`;
    if (looksLikeValidRedisUrl(built)) return built;
  }

  return null;
}

function getRedisUrl() {
  return resolvedRedisUrl;
}

function getRedisDiagnostics() {
  const raw = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL || '';
  return {
    configured: Boolean(resolveRedisUrl() || looksLikeValidRedisUrl(raw)),
    connected: isRedisConnected(),
    urlPreview: resolvedRedisUrl ? redactUrl(resolvedRedisUrl) : null,
    envPresent: Boolean(process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL || process.env.REDISHOST || process.env.REDIS_HOST),
    lastError: lastRedisError
  };
}

function createRedisClient(url) {
  const { createClient } = require('redis');
  // family: 0 fixes common Railway IPv6 / dual-stack connection failures
  return createClient({
    url,
    socket: {
      family: 0,
      reconnectStrategy: (retries) => Math.min(retries * 100, 3000)
    }
  });
}

async function touchTTL() {
  if (!usingRedis) return;
  await redisClient.expire(META_KEY, SESSION_TTL_SECONDS);
  await redisClient.expire(PARTICIPANTS_KEY, SESSION_TTL_SECONDS);
}

async function connect() {
  lastRedisError = null;
  const url = resolveRedisUrl();

  if (!url) {
    lastRedisError = 'No valid REDIS_URL (or host/password) found in environment';
    console.warn(lastRedisError);
    console.warn('In Railway web service set: REDIS_URL=${{Redis.REDIS_URL}}');
    console.warn('Env check — REDIS_URL set:', Boolean(process.env.REDIS_URL),
      '| REDISHOST set:', Boolean(process.env.REDISHOST || process.env.REDIS_HOST));
    return false;
  }

  try {
    redisClient = createRedisClient(url);
    redisClient.on('error', (err) => {
      console.error('Redis error:', err.message);
      lastRedisError = err.message;
    });
    await redisClient.connect();
    await redisClient.ping();
    usingRedis = true;
    resolvedRedisUrl = url;
    console.log('Connected to Redis session store:', redactUrl(url));
    return true;
  } catch (err) {
    lastRedisError = err.message;
    console.error('Redis connection failed — falling back to in-memory store:', err.message);
    console.error('Attempted URL:', redactUrl(url));
    usingRedis = false;
    resolvedRedisUrl = null;
    try {
      if (redisClient) await redisClient.quit().catch(() => {});
    } catch (_) { /* ignore */ }
    redisClient = null;
    return false;
  }
}

function isRedisConnected() {
  return usingRedis && redisClient?.isOpen;
}

async function getMeta() {
  if (!usingRedis) return { ...memoryMeta };

  const raw = await redisClient.get(META_KEY);
  if (!raw) return { ...DEFAULT_META };
  return JSON.parse(raw);
}

async function setMeta(meta) {
  if (!usingRedis) {
    Object.assign(memoryMeta, meta);
    return;
  }

  await redisClient.set(META_KEY, JSON.stringify(meta));
  await touchTTL();
}

async function getAllParticipants() {
  if (!usingRedis) return new Map(memoryParticipants);

  const raw = await redisClient.hGetAll(PARTICIPANTS_KEY);
  const map = new Map();
  Object.entries(raw).forEach(([id, json]) => {
    try {
      map.set(id, JSON.parse(json));
    } catch {
      // skip corrupt entries
    }
  });
  return map;
}

async function getParticipant(id) {
  if (!usingRedis) return memoryParticipants.get(id) || null;

  const raw = await redisClient.hGet(PARTICIPANTS_KEY, id);
  return raw ? JSON.parse(raw) : null;
}

async function setParticipant(participant) {
  const stored = participantForStorage(participant);
  if (!usingRedis) {
    memoryParticipants.set(participant.id, { ...stored });
    return;
  }

  await redisClient.hSet(PARTICIPANTS_KEY, participant.id, JSON.stringify(stored));
  await touchTTL();
}

async function setParticipants(participantsMap) {
  if (!usingRedis) {
    memoryParticipants.clear();
    participantsMap.forEach((p, id) => memoryParticipants.set(id, participantForStorage(p)));
    return;
  }

  const pipeline = redisClient.multi();
  pipeline.del(PARTICIPANTS_KEY);
  participantsMap.forEach((p, id) => {
    pipeline.hSet(PARTICIPANTS_KEY, id, JSON.stringify(participantForStorage(p)));
  });
  await pipeline.exec();
  await touchTTL();
}

async function deleteParticipant(id) {
  if (!usingRedis) {
    memoryParticipants.delete(id);
    return;
  }

  await redisClient.hDel(PARTICIPANTS_KEY, id);
  await touchTTL();
}

async function resetSession() {
  if (!usingRedis) {
    Object.assign(memoryMeta, DEFAULT_META);
    memoryParticipants.clear();
    return;
  }

  await redisClient.del(META_KEY, PARTICIPANTS_KEY);
}

async function prepareForNewStudents() {
  const meta = await getMeta();
  if (meta.status === 'completed') {
    await resetSession();
    await setMeta({ ...DEFAULT_META });
  }
}

module.exports = {
  connect,
  createRedisClient,
  getRedisUrl,
  getRedisDiagnostics,
  isRedisConnected,
  getMeta,
  setMeta,
  getAllParticipants,
  getParticipant,
  setParticipant,
  setParticipants,
  deleteParticipant,
  resetSession,
  prepareForNewStudents
};
