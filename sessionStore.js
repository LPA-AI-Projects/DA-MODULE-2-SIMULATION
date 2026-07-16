const META_KEY = 'simulation:session:meta';
const PARTICIPANTS_KEY = 'simulation:session:participants';
const SESSION_TTL_SECONDS = 86400;

const DEFAULT_META = { status: 'waiting', startedAt: null };

let redisClient = null;
let usingRedis = false;
let resolvedRedisUrl = null;

const memoryMeta = { ...DEFAULT_META };
const memoryParticipants = new Map();

function participantForStorage(participant) {
  const { socketId, ...rest } = participant;
  return rest;
}

function looksLikeValidRedisUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.includes('undefined') || url.includes('null')) return false;
  try {
    const parsed = new URL(url);
    if (!['redis:', 'rediss:'].includes(parsed.protocol)) return false;
    if (!parsed.hostname) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve Redis URL from Railway / common env vars.
 * Prefers a full REDIS_URL; falls back to host/port/password parts.
 */
function resolveRedisUrl() {
  const candidates = [
    process.env.REDIS_URL,
    process.env.REDIS_PRIVATE_URL,
    process.env.REDIS_PUBLIC_URL
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (looksLikeValidRedisUrl(candidate)) return candidate.trim();
  }

  const host = process.env.REDISHOST || process.env.REDIS_HOST;
  const port = process.env.REDISPORT || process.env.REDIS_PORT || '6379';
  const password = process.env.REDISPASSWORD || process.env.REDIS_PASSWORD;
  const user = process.env.REDISUSER || process.env.REDIS_USER || '';

  if (host && password && !String(password).includes('undefined')) {
    const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}` : `:${encodeURIComponent(password)}`;
    const built = `redis://${auth}@${host}:${port}`;
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

async function touchTTL() {
  if (!usingRedis) return;
  await redisClient.expire(META_KEY, SESSION_TTL_SECONDS);
  await redisClient.expire(PARTICIPANTS_KEY, SESSION_TTL_SECONDS);
}

async function connect() {
  const url = resolveRedisUrl();
  if (!url) {
    console.warn('No valid Redis URL found — using in-memory session store (data lost on restart).');
    console.warn('Set REDIS_URL to the full URL from Railway Redis (Variables → REDIS_URL).');
    return false;
  }

  try {
    const { createClient } = require('redis');
    redisClient = createClient({ url });
    redisClient.on('error', (err) => console.error('Redis error:', err.message));
    await redisClient.connect();
    usingRedis = true;
    resolvedRedisUrl = url;
    console.log('Connected to Redis session store.');
    return true;
  } catch (err) {
    console.error('Redis connection failed — falling back to in-memory store:', err.message);
    usingRedis = false;
    resolvedRedisUrl = null;
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
  getRedisUrl,
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
