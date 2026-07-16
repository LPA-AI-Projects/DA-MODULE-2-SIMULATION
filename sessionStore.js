const META_KEY = 'simulation:session:meta';
const PARTICIPANTS_KEY = 'simulation:session:participants';
const SESSION_TTL_SECONDS = 86400;

const DEFAULT_META = { status: 'waiting', startedAt: null };

let redisClient = null;
let usingRedis = false;

const memoryMeta = { ...DEFAULT_META };
const memoryParticipants = new Map();

function participantForStorage(participant) {
  const { socketId, ...rest } = participant;
  return rest;
}

async function touchTTL() {
  if (!usingRedis) return;
  await redisClient.expire(META_KEY, SESSION_TTL_SECONDS);
  await redisClient.expire(PARTICIPANTS_KEY, SESSION_TTL_SECONDS);
}

async function connect() {
  if (!process.env.REDIS_URL) {
    console.warn('REDIS_URL not set — using in-memory session store (data lost on restart).');
    return false;
  }

  const { createClient } = require('redis');
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => console.error('Redis error:', err.message));
  await redisClient.connect();
  usingRedis = true;
  console.log('Connected to Redis session store.');
  return true;
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
