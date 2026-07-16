const META_KEY = 'simulation:session:meta';
const PARTICIPANTS_KEY = 'simulation:session:participants';
const SESSION_TTL_SECONDS = 86400;

const DEFAULT_META = { status: 'waiting', startedAt: null };

let redisClient = null;
let usingRedis = false;
let resolvedRedisUrl = null;
let lastRedisError = null;
let lastResolveNote = null;
let lastClientOptions = null; // url string or discrete config for adapters

const memoryMeta = { ...DEFAULT_META };
const memoryParticipants = new Map();

function participantForStorage(participant) {
  const { socketId, ...rest } = participant;
  return rest;
}

function cleanEnv(value) {
  if (value == null) return '';
  let s = String(value).trim();
  // Strip wrapping quotes Railway / copy-paste sometimes adds
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function isBadToken(value) {
  const s = cleanEnv(value).toLowerCase();
  return !s || s === 'undefined' || s === 'null' || s.includes('${{') || s.includes('}}');
}

function looksLikeValidRedisUrl(url) {
  if (isBadToken(url)) return false;
  const trimmed = cleanEnv(url);
  if (trimmed === 'redis://:@' || /^redis:\/\/:?@?$/.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    if (!['redis:', 'rediss:'].includes(parsed.protocol)) return false;
    if (!parsed.hostname || isBadToken(parsed.hostname)) return false;
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
    return '(unparseable)';
  }
}

function getDiscreteRedisConfig() {
  const host = cleanEnv(
    process.env.REDISHOST ||
    process.env.REDIS_HOST ||
    process.env.REDIS_PRIVATE_HOST
  );
  const port = cleanEnv(
    process.env.REDISPORT ||
    process.env.REDIS_PORT ||
    process.env.REDIS_PRIVATE_PORT ||
    '6379'
  ) || '6379';
  const password = cleanEnv(
    process.env.REDISPASSWORD ||
    process.env.REDIS_PASSWORD ||
    process.env.REDIS_PRIVATE_PASSWORD
  );
  const username = cleanEnv(
    process.env.REDISUSER ||
    process.env.REDIS_USER ||
    'default'
  ) || 'default';

  if (isBadToken(host)) return null;
  return {
    host,
    port: Number(port) || 6379,
    password: password && !isBadToken(password) ? password : undefined,
    username: username && !isBadToken(username) ? username : 'default'
  };
}

/**
 * Resolve Redis connection: prefer valid URL, else build from Railway host vars.
 */
function resolveRedisConnection() {
  lastResolveNote = null;

  const urlCandidates = [
    process.env.REDIS_URL,
    process.env.REDIS_PRIVATE_URL,
    process.env.REDIS_PUBLIC_URL
  ];

  for (const raw of urlCandidates) {
    const candidate = cleanEnv(raw);
    if (!candidate) continue;
    if (looksLikeValidRedisUrl(candidate)) {
      lastResolveNote = 'Using REDIS_URL';
      return { type: 'url', url: candidate };
    }
    lastResolveNote = `REDIS_URL present but invalid: ${redactUrl(candidate)} (raw length ${candidate.length})`;
  }

  const discrete = getDiscreteRedisConfig();
  if (discrete) {
    const auth = discrete.password
      ? `${encodeURIComponent(discrete.username)}:${encodeURIComponent(discrete.password)}@`
      : '';
    const url = `redis://${auth}${discrete.host}:${discrete.port}`;
    if (looksLikeValidRedisUrl(url)) {
      lastResolveNote = `Built URL from REDISHOST/REDISPASSWORD (${discrete.host}:${discrete.port})`;
      return { type: 'url', url, discrete };
    }
    lastResolveNote = 'REDISHOST found but could not build a valid URL';
    return { type: 'discrete', discrete };
  }

  lastResolveNote = 'No REDIS_URL or REDISHOST/REDISPASSWORD found';
  return null;
}

function getRedisUrl() {
  return resolvedRedisUrl;
}

function getRedisDiagnostics() {
  const rawUrl = cleanEnv(process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL || '');
  const discrete = getDiscreteRedisConfig();
  return {
    configured: Boolean(rawUrl || discrete),
    connected: isRedisConnected(),
    urlPreview: resolvedRedisUrl ? redactUrl(resolvedRedisUrl) : null,
    envPresent: Boolean(
      process.env.REDIS_URL ||
      process.env.REDIS_PRIVATE_URL ||
      process.env.REDISHOST ||
      process.env.REDIS_HOST
    ),
    envKeys: {
      REDIS_URL: Boolean(process.env.REDIS_URL),
      REDIS_PRIVATE_URL: Boolean(process.env.REDIS_PRIVATE_URL),
      REDISHOST: Boolean(process.env.REDISHOST || process.env.REDIS_HOST),
      REDISPORT: Boolean(process.env.REDISPORT || process.env.REDIS_PORT),
      REDISPASSWORD: Boolean(process.env.REDISPASSWORD || process.env.REDIS_PASSWORD),
      REDISUSER: Boolean(process.env.REDISUSER || process.env.REDIS_USER)
    },
    invalidUrlPreview: rawUrl && !looksLikeValidRedisUrl(rawUrl) ? redactUrl(rawUrl) : null,
    resolveNote: lastResolveNote,
    lastError: lastRedisError
  };
}

function createRedisClient(urlOrOptions) {
  const { createClient } = require('redis');
  const baseSocket = {
    family: 0,
    reconnectStrategy: (retries) => Math.min(retries * 100, 3000)
  };

  if (typeof urlOrOptions === 'string') {
    return createClient({
      url: urlOrOptions,
      socket: baseSocket
    });
  }

  // Discrete Railway vars — more reliable when REDIS_URL is malformed
  return createClient({
    username: urlOrOptions.username,
    password: urlOrOptions.password,
    socket: {
      ...baseSocket,
      host: urlOrOptions.host,
      port: urlOrOptions.port
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
  const connection = resolveRedisConnection();

  if (!connection) {
    lastRedisError = lastResolveNote || 'No valid Redis configuration in environment';
    console.warn(lastRedisError);
    console.warn('Set on Railway web service: REDIS_URL=${{Redis.REDIS_URL}}');
    console.warn('Or share Redis variables: REDISHOST, REDISPORT, REDISPASSWORD, REDISUSER');
    return false;
  }

  try {
    if (connection.type === 'url') {
      redisClient = createRedisClient(connection.url);
      resolvedRedisUrl = connection.url;
      lastClientOptions = connection.url;
    } else {
      redisClient = createRedisClient(connection.discrete);
      resolvedRedisUrl = `redis://${connection.discrete.host}:${connection.discrete.port}`;
      lastClientOptions = connection.discrete;
    }

    redisClient.on('error', (err) => {
      console.error('Redis error:', err.message);
      lastRedisError = err.message;
    });

    await redisClient.connect();
    await redisClient.ping();
    usingRedis = true;
    console.log('Connected to Redis:', resolvedRedisUrl ? redactUrl(resolvedRedisUrl) : '(discrete)');
    console.log(lastResolveNote);
    return true;
  } catch (err) {
    lastRedisError = err.message;
    console.error('Redis connection failed — falling back to in-memory store:', err.message);
    if (resolvedRedisUrl) console.error('Attempted URL:', redactUrl(resolvedRedisUrl));
    console.error(lastResolveNote);
    usingRedis = false;
    resolvedRedisUrl = null;
    lastClientOptions = null;
    try {
      if (redisClient) await redisClient.quit().catch(() => {});
    } catch (_) { /* ignore */ }
    redisClient = null;
    return false;
  }
}

function getClientOptions() {
  return lastClientOptions;
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
