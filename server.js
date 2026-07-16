const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const sessionStore = require('./sessionStore');

const TRAINER_CODE = process.env.TRAINER_CODE || '2468';
const PORT = process.env.PORT || 3001;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*' }
});

const trainers = new Set();
const socketToParticipant = new Map();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', async (_req, res) => {
  try {
    const meta = await sessionStore.getMeta();
    const redis = sessionStore.getRedisDiagnostics();
    res.json({
      ok: true,
      redis: redis.connected,
      redisConfigured: redis.envPresent,
      redisUrl: redis.urlPreview,
      redisInvalidUrl: redis.invalidUrlPreview,
      redisEnvKeys: redis.envKeys,
      redisNote: redis.resolveNote,
      redisError: redis.lastError,
      sessionStatus: meta.status
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

function participantToJSON(p) {
  return {
    id: p.id,
    name: p.name,
    studentId: p.studentId || '',
    status: p.status,
    currentQuestion: p.currentQuestion,
    questionsAttempted: p.questionsAttempted,
    currentScore: p.currentScore,
    completionPct: p.completionPct,
    finalScore: p.finalScore,
    percentage: p.percentage,
    timeTaken: p.timeTaken,
    rank: p.rank,
    correctCount: p.correctCount,
    incorrectCount: p.incorrectCount,
    completedAt: p.completedAt,
    report: p.report || null,
    forceCompleted: !!p.forceCompleted,
    engineState: p.engineState || null
  };
}

function buildLeaderboard(participants) {
  const completed = participants.filter(p => p.status === 'Completed');
  const sorted = [...completed].sort((a, b) => {
    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
    return (a.timeTaken || Infinity) - (b.timeTaken || Infinity);
  });
  return sorted.map((p, i) => ({
    rank: i + 1,
    id: p.id,
    name: p.name,
    studentId: p.studentId || '',
    finalScore: p.finalScore,
    percentage: p.percentage,
    timeTaken: p.timeTaken
  }));
}

function buildAnalytics(participants) {
  const completed = participants.filter(p => p.status === 'Completed' && p.report);
  if (!completed.length) return null;

  const scores = completed.map(p => p.finalScore);
  const pcts = completed.map(p => p.percentage);
  const times = completed.map(p => p.timeTaken || 0);
  const totalQ = 20;

  const questionStats = {};
  const topicStats = {};
  const mistakePatterns = [];

  for (let q = 1; q <= totalQ; q++) {
    questionStats[q] = { attempts: 0, correct: 0, incorrect: 0 };
  }

  completed.forEach(p => {
    (p.report.correct || []).forEach(item => {
      if (!topicStats[item.topic]) topicStats[item.topic] = { correct: 0, total: 0 };
      topicStats[item.topic].correct++;
      topicStats[item.topic].total++;
      const qNum = item.questionNumber;
      if (questionStats[qNum]) {
        questionStats[qNum].attempts++;
        questionStats[qNum].correct++;
      }
    });
    (p.report.incorrect || []).forEach(item => {
      if (!topicStats[item.topic]) topicStats[item.topic] = { correct: 0, total: 0 };
      topicStats[item.topic].total++;
      const qNum = item.questionNumber;
      if (questionStats[qNum]) {
        questionStats[qNum].attempts++;
        questionStats[qNum].incorrect++;
      }
      if (item.selectedAnswer) {
        mistakePatterns.push({
          questionNumber: qNum,
          topic: item.topic,
          selected: item.selectedAnswer,
          correct: item.correctAnswer
        });
      }
    });
  });

  const questionAnalysis = Object.entries(questionStats).map(([num, s]) => ({
    questionNumber: Number(num),
    totalAttempts: s.attempts,
    correctResponses: s.correct,
    incorrectResponses: s.incorrect,
    accuracy: s.attempts ? Math.round((s.correct / s.attempts) * 100) : 0
  }));

  const topicAnalysis = Object.entries(topicStats).map(([topic, s]) => ({
    topic,
    averageAccuracy: s.total ? Math.round((s.correct / s.total) * 100) : 0
  })).sort((a, b) => a.averageAccuracy - b.averageAccuracy);

  const weakestQuestions = [...questionAnalysis]
    .filter(q => q.totalAttempts > 0)
    .sort((a, b) => a.accuracy - b.accuracy)
    .slice(0, 5);

  const commonMistakes = summarizeMistakes(mistakePatterns, completed.length);
  const facilitatorInsights = generateFacilitatorSummary(
    completed.length,
    pcts,
    topicAnalysis,
    commonMistakes
  );

  return {
    overall: {
      totalParticipants: completed.length,
      averageScore: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10,
      highestScore: Math.max(...scores),
      lowestScore: Math.min(...scores),
      averageCompletionTime: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
      averageAccuracy: Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length)
    },
    questionAnalysis,
    weakestQuestions,
    topicAnalysis,
    commonMistakes,
    facilitatorInsights,
    finalLeaderboard: buildLeaderboard(participants)
  };
}

function summarizeMistakes(patterns, totalParticipants) {
  const byQuestion = {};
  const byTopic = {};

  patterns.forEach(m => {
    const key = `Q${m.questionNumber}`;
    if (!byQuestion[key]) byQuestion[key] = { count: 0, selected: {}, correct: m.correct, topic: m.topic };
    byQuestion[key].count++;
    byQuestion[key].selected[m.selected] = (byQuestion[key].selected[m.selected] || 0) + 1;
    byTopic[m.topic] = (byTopic[m.topic] || 0) + 1;
  });

  const mistakes = [];
  Object.entries(byQuestion).forEach(([q, data]) => {
    const topSelected = Object.entries(data.selected).sort((a, b) => b[1] - a[1])[0];
    if (topSelected && data.count >= 2) {
      mistakes.push(
        `${data.count} participant(s) struggled with ${q} (${data.topic}) — many selected "${topSelected[0]}" instead of the correct answer "${data.correct}".`
      );
    }
  });

  Object.entries(byTopic)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .forEach(([topic, count]) => {
      if (count >= 2) {
        const pct = Math.round((count / totalParticipants) * 100);
        mistakes.push(`Several participants (${pct}% of batch) had difficulty with ${topic} concepts.`);
      }
    });

  if (!mistakes.length) {
    mistakes.push('No dominant mistake patterns detected — performance was distributed across topics.');
  }
  return mistakes;
}

function generateFacilitatorSummary(count, pcts, topicAnalysis, commonMistakes) {
  const avgAcc = Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
  const strong = topicAnalysis.filter(t => t.averageAccuracy >= 75).map(t => t.topic);
  const weak = topicAnalysis.filter(t => t.averageAccuracy < 60).map(t => t.topic);

  let summary = `This batch of ${count} participant${count !== 1 ? 's' : ''} achieved an average accuracy of ${avgAcc}%. `;

  if (strong.length) {
    summary += `Strong performance was observed in ${strong.join(', ')}. `;
  }
  if (weak.length) {
    const weakPct = Math.round(
      topicAnalysis.filter(t => t.averageAccuracy < 60).reduce((a, t) => a + t.averageAccuracy, 0) /
      weak.length
    );
    summary += `However, the group consistently struggled with ${weak.join(', ')}, with average accuracy around ${weakPct}% in those areas. `;
    summary += `Approximately ${Math.round((weak.length / topicAnalysis.length) * 100)}% of topic areas need reinforcement. `;
    summary += 'It is recommended to revisit these concepts through additional examples and guided practice before advancing to the next module.';
  } else {
    summary += 'Overall, the batch demonstrated solid understanding across all topic areas. Consider introducing more advanced scenarios in the next session.';
  }

  if (commonMistakes[0] && !commonMistakes[0].includes('No dominant')) {
    summary += ` Key pattern: ${commonMistakes[0]}`;
  }

  return summary;
}

async function getSessionSnapshot() {
  let meta = await sessionStore.getMeta();
  const participantsMap = await sessionStore.getAllParticipants();
  let participants = Array.from(participantsMap.values()).map(participantToJSON);

  const allCompleted = participants.length > 0 && participants.every(p => p.status === 'Completed');
  if (allCompleted && meta.status === 'active') {
    meta = { ...meta, status: 'completed' };
    await sessionStore.setMeta(meta);
  }

  return {
    status: meta.status,
    startedAt: meta.startedAt,
    participants,
    leaderboard: buildLeaderboard(participants),
    analytics: meta.status === 'completed' ? buildAnalytics(participants) : null,
    allCompleted
  };
}

async function broadcastSession() {
  const snapshot = await getSessionSnapshot();
  io.emit('session:update', snapshot);
  return snapshot;
}

function registerSocket(socket, participantId) {
  socketToParticipant.set(socket.id, participantId);
}

function unregisterSocket(socketId) {
  socketToParticipant.delete(socketId);
}

io.on('connection', (socket) => {
  socket.on('student:join', async ({ name, studentId }) => {
    try {
      if (!name || !name.trim()) {
        socket.emit('error', { message: 'Name is required.' });
        return;
      }

      await sessionStore.prepareForNewStudents();
      const meta = await sessionStore.getMeta();

      if (meta.status === 'completed') {
        socket.emit('error', { message: 'Session has ended. Please wait for the trainer to reset.' });
        return;
      }

      if (meta.status !== 'waiting' && meta.status !== 'active') {
        socket.emit('error', { message: 'Session has ended. Please wait for the trainer to reset.' });
        return;
      }

      const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const participant = {
        id,
        socketId: socket.id,
        name: name.trim(),
        studentId: (studentId || '').trim(),
        status: meta.status === 'active' ? 'In Progress' : 'Waiting',
        currentQuestion: meta.status === 'active' ? 'Q1' : '—',
        questionsAttempted: 0,
        currentScore: 0,
        completionPct: 0,
        finalScore: 0,
        percentage: 0,
        timeTaken: null,
        rank: null,
        correctCount: 0,
        incorrectCount: 0,
        startedAt: meta.status === 'active' ? Date.now() : null,
        completedAt: null,
        report: null
      };

      await sessionStore.setParticipant(participant);
      registerSocket(socket, id);
      socket.join('students');
      socket.participantId = id;
      socket.role = 'student';

      socket.emit('student:joined', { participantId: id, session: await getSessionSnapshot() });
      await broadcastSession();
    } catch (err) {
      console.error('student:join error:', err);
      socket.emit('error', { message: 'Could not join session. Please try again.' });
    }
  });

  socket.on('student:rejoin', async ({ participantId: id }) => {
    try {
      if (!id) {
        socket.emit('student:rejoinFailed', { message: 'Missing participant id.' });
        return;
      }
      const p = await sessionStore.getParticipant(id);
      if (!p) {
        socket.emit('student:rejoinFailed', { message: 'Session not found. Please log in again.' });
        return;
      }

      // If marked Incomplete by force-complete but they reconnect mid-sim, keep Incomplete unless they finish
      socket.participantId = id;
      socket.role = 'student';
      registerSocket(socket, id);
      socket.join('students');

      socket.emit('student:rejoined', {
        participantId: id,
        participant: participantToJSON(p),
        engineState: p.engineState || null,
        session: await getSessionSnapshot()
      });
      await broadcastSession();
    } catch (err) {
      console.error('student:rejoin error:', err);
      socket.emit('student:rejoinFailed', { message: 'Could not restore session.' });
    }
  });

  socket.on('trainer:join', async ({ code }) => {
    try {
      if (String(code) !== TRAINER_CODE) {
        socket.emit('trainer:denied', { message: 'Invalid Access Code' });
        return;
      }
      trainers.add(socket.id);
      socket.join('trainers');
      socket.role = 'trainer';
      socket.emit('trainer:joined', { session: await getSessionSnapshot() });
    } catch (err) {
      console.error('trainer:join error:', err);
      socket.emit('error', { message: 'Could not join trainer dashboard.' });
    }
  });

  socket.on('trainer:start', async () => {
    try {
      if (!trainers.has(socket.id)) return;

      const meta = await sessionStore.getMeta();
      // Only start from waiting — completed sessions must be Reset first
      if (meta.status !== 'waiting') return;

      const newMeta = { status: 'active', startedAt: Date.now() };
      await sessionStore.setMeta(newMeta);

      const participants = await sessionStore.getAllParticipants();
      for (const [, p] of participants) {
        if (p.status === 'Waiting') {
          p.status = 'In Progress';
          p.startedAt = Date.now();
          p.currentQuestion = 'START';
          await sessionStore.setParticipant(p);
        }
      }

      await broadcastSession();
    } catch (err) {
      console.error('trainer:start error:', err);
    }
  });

  socket.on('trainer:reset', async () => {
    try {
      if (!trainers.has(socket.id)) return;

      await sessionStore.resetSession();
      await sessionStore.setMeta({ status: 'waiting', startedAt: null });
      socketToParticipant.clear();
      io.emit('session:reset');
      await broadcastSession();
    } catch (err) {
      console.error('trainer:reset error:', err);
    }
  });

  socket.on('trainer:forceComplete', async () => {
    try {
      if (!trainers.has(socket.id)) return;

      const meta = await sessionStore.getMeta();
      if (meta.status !== 'active') return;

      const TOTAL_Q = 20;
      const participants = await sessionStore.getAllParticipants();
      let finishedCount = 0;

      for (const [, p] of participants) {
        if (p.status === 'Completed' && p.report) {
          finishedCount++;
          continue;
        }

        // Finalize mid-session students with score earned so far
        const score = Number(p.currentScore) || 0;
        const attempted = Number(p.questionsAttempted) || 0;
        const startedAt = p.startedAt || meta.startedAt || Date.now();
        const timeTaken = Math.max(0, Math.round((Date.now() - startedAt) / 1000));

        p.status = 'Completed';
        p.currentQuestion = 'Finished';
        p.finalScore = Math.round(score * 10) / 10;
        p.percentage = Math.round((score / TOTAL_Q) * 100);
        p.currentScore = p.finalScore;
        p.completionPct = Math.round((attempted / TOTAL_Q) * 100);
        p.correctCount = p.correctCount || 0;
        p.incorrectCount = p.incorrectCount || 0;
        p.timeTaken = p.timeTaken || timeTaken;
        p.completedAt = Date.now();
        p.forceCompleted = true;

        if (!p.report) {
          const base = p.partialReport || { correct: [], incorrect: [], learningSummary: '' };
          p.report = {
            correct: base.correct || [],
            incorrect: base.incorrect || [],
            learningSummary: (base.learningSummary || 'Progress saved.') +
              ' Session was ended early by the trainer; unanswered questions count as 0.'
          };
        }

        await sessionStore.setParticipant(p);
        finishedCount++;
      }

      await sessionStore.setMeta({ ...meta, status: 'completed' });
      const snapshot = await broadcastSession();

      // Refresh ranks
      for (const entry of snapshot.leaderboard) {
        const part = await sessionStore.getParticipant(entry.id);
        if (part) {
          part.rank = entry.rank;
          await sessionStore.setParticipant(part);
        }
      }
      await broadcastSession();

      io.emit('session:forceCompleted', {
        message: 'The trainer ended the session. Your score so far has been recorded.'
      });

      socket.emit('trainer:forceCompleted', {
        hasAnalytics: finishedCount > 0,
        message: finishedCount
          ? 'Session force-completed. All participants finalized with scores so far. Analytics are ready.'
          : 'Session force-completed, but there were no participants.'
      });
    } catch (err) {
      console.error('trainer:forceComplete error:', err);
    }
  });

  socket.on('student:progress', async (data) => {
    try {
      const meta = await sessionStore.getMeta();
      if (meta.status !== 'active') return;

      const p = socket.participantId ? await sessionStore.getParticipant(socket.participantId) : null;
      if (!p || p.status === 'Completed') return;

      p.status = data.status || p.status;
      p.currentQuestion = data.currentQuestion ?? p.currentQuestion;
      p.questionsAttempted = data.questionsAttempted ?? p.questionsAttempted;
      p.currentScore = data.currentScore ?? p.currentScore;
      p.completionPct = data.completionPct ?? p.completionPct;
      p.correctCount = data.correctCount ?? p.correctCount;
      p.incorrectCount = data.incorrectCount ?? p.incorrectCount;
      if (data.finalScore != null) p.finalScore = data.finalScore;
      if (data.percentage != null) p.percentage = data.percentage;
      if (data.report) p.partialReport = data.report;
      if (data.engineState) p.engineState = data.engineState;

      await sessionStore.setParticipant(p);
      await broadcastSession();
    } catch (err) {
      console.error('student:progress error:', err);
    }
  });

  socket.on('student:complete', async (data) => {
    try {
      const p = socket.participantId ? await sessionStore.getParticipant(socket.participantId) : null;
      if (!p) return;

      // Allow finish even after trainer force-completes the session
      p.status = 'Completed';
      p.currentQuestion = 'Finished';
      p.questionsAttempted = data.questionsAttempted ?? 20;
      p.finalScore = data.finalScore ?? 0;
      p.percentage = data.percentage ?? 0;
      p.currentScore = data.finalScore ?? 0;
      p.completionPct = 100;
      p.correctCount = data.correctCount ?? 0;
      p.incorrectCount = data.incorrectCount ?? 0;
      p.timeTaken = data.timeTaken ?? 0;
      p.completedAt = Date.now();
      p.report = data.report ?? null;

      await sessionStore.setParticipant(p);

      const snapshot = await broadcastSession();
      for (const entry of snapshot.leaderboard) {
        const part = await sessionStore.getParticipant(entry.id);
        if (part) {
          part.rank = entry.rank;
          await sessionStore.setParticipant(part);
        }
      }
      await broadcastSession();
    } catch (err) {
      console.error('student:complete error:', err);
    }
  });

  socket.on('disconnect', async () => {
    try {
      trainers.delete(socket.id);
      unregisterSocket(socket.id);
      // Keep participant data in Redis/memory so refresh can restore the session.
      // Cleanup happens only on trainer Reset Session.
    } catch (err) {
      console.error('disconnect error:', err);
    }
  });
});

async function setupSocketAdapter() {
  const options = sessionStore.getClientOptions();
  if (!options || !sessionStore.isRedisConnected()) return;

  try {
    const { createAdapter } = require('@socket.io/redis-adapter');
    const pubClient = sessionStore.createRedisClient(options);
    const subClient = pubClient.duplicate();

    pubClient.on('error', (err) => console.error('Redis pub error:', err.message));
    subClient.on('error', (err) => console.error('Redis sub error:', err.message));

    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    console.log('Socket.io Redis adapter enabled.');
  } catch (err) {
    console.error('Socket.io Redis adapter failed (continuing without it):', err.message);
  }
}

async function start() {
  await sessionStore.connect();
  await setupSocketAdapter();

  // Bind to 0.0.0.0 so Railway proxy can reach the app
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Simulation platform running on port ${PORT}`);
    console.log(`Redis: ${sessionStore.isRedisConnected() ? 'connected' : 'in-memory fallback'}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
