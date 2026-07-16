const fs = require('fs');
const path = require('path');

const basePath = path.join(__dirname, 'public', 'simulation-base.html');
const base = fs.readFileSync(basePath, 'utf8');

const styleMatch = base.match(/<style>([\s\S]*?)<\/style>/);
const scriptMatch = base.match(/<script>([\s\S]*?)<\/script>/);

if (!styleMatch || !scriptMatch) throw new Error('Could not parse simulation base');

let simScript = scriptMatch[1];

// Transform IIFE to SimulationEngine module with hooks
simScript = simScript.replace(
  '(function(){',
  `window.SimulationEngine = (function(){\n  let hooks = {};\n  let sessionStartTime = null;\n  const answerLog = [];`
);

simScript = simScript.replace(
  /render\(\);\s*\}\)\(\);/,
  `function getCorrectAnswerText(q) {
    if (q.kind === 'table') {
      const row = q.table.rows.find(r => r.correct);
      return row ? row.cells.join(' | ') : 'See question';
    }
    if (q.kind === 'options') {
      const opt = q.options.find(o => o.correct);
      return opt ? opt.text : 'See question';
    }
    return 'See question';
  }

  function getSelectedAnswerText(q, key) {
    const k = Number(key);
    if (q.kind === 'table') {
      const row = q.table.rows[k];
      return row ? row.cells.join(' | ') : '—';
    }
    if (q.kind === 'options') {
      const opt = q.options[k];
      return opt ? (opt.tag + '. ' + opt.text) : '—';
    }
    return '—';
  }

  function buildReport() {
    const correct = [];
    const incorrect = [];
    topics.forEach((t, ti) => {
      t.questions.forEach((q, qi) => {
        const globalIdx = questionsDoneBefore(ti) + qi + 1;
        const entry = answerLog.find(a => a.ti === ti && a.qi === qi);
        const pts = scores[ti + '-' + qi] || 0;
        if (pts > 0) {
          correct.push({ questionNumber: globalIdx, topic: t.name, correct: getCorrectAnswerText(q) });
        } else {
          incorrect.push({
            questionNumber: globalIdx,
            topic: t.name,
            correctAnswer: getCorrectAnswerText(q),
            selectedAnswer: entry ? entry.selectedAnswer : '—'
          });
        }
      });
    });
    return { correct, incorrect, learningSummary: generateLearningSummary(correct, incorrect) };
  }

  function generateLearningSummary(correct, incorrect) {
    const topicPerf = {};
    correct.forEach(c => { topicPerf[c.topic] = topicPerf[c.topic] || { ok: 0, bad: 0 }; topicPerf[c.topic].ok++; });
    incorrect.forEach(c => { topicPerf[c.topic] = topicPerf[c.topic] || { ok: 0, bad: 0 }; topicPerf[c.topic].bad++; });
    const strong = Object.entries(topicPerf).filter(([, v]) => v.ok >= v.bad && v.ok > 0).map(([t]) => t);
    const weak = Object.entries(topicPerf).filter(([, v]) => v.bad > v.ok).map(([t]) => t);
    let s = '';
    if (strong.length) s += 'You performed well in ' + strong.join(', ') + '. ';
    if (weak.length) s += 'However, you struggled with ' + weak.join(', ') + '. Focus on these topics before attempting the next simulation.';
    else if (!s) s = 'Review your incorrect answers and revisit the related Excel concepts before your next attempt.';
    return s;
  }

  function syncProgress(label) {
    if (!hooks.onProgress) return;
    const totalQ = totalQuestions();
    let attempted = 0;
    let currentScore = 0;
    Object.keys(scores).forEach(k => { attempted++; currentScore += scores[k]; });
    let correctCount = 0, incorrectCount = 0;
    answerLog.forEach(a => { if (a.finalCorrect) correctCount++; else if (a.locked) incorrectCount++; });
    const s = screens[ptr];
    let currentQuestion = label || 'START';
    if (s.type === 'question') currentQuestion = 'Q' + (questionsDoneBefore(s.t) + s.q + 1);
    else if (s.type === 'topicIntro') currentQuestion = 'Topic ' + (s.t + 1);
    else if (s.type === 'topicRecap') currentQuestion = 'Recap T' + (s.t + 1);
    else if (s.type === 'results') currentQuestion = 'Finished';
    hooks.onProgress({
      status: s.type === 'results' ? 'Completed' : 'In Progress',
      currentQuestion,
      questionsAttempted: attempted,
      currentScore: Math.round(currentScore * 10) / 10,
      completionPct: Math.round((attempted / totalQ) * 100),
      correctCount,
      incorrectCount
    });
  }

  function init(h) {
    hooks = h || {};
    sessionStartTime = Date.now();
    ptr = 0; attempts = 0; locked = false;
    Object.keys(scores).forEach(k => delete scores[k]);
    answerLog.length = 0;
    render();
    syncProgress('START');
  }

  return { init, topics };
})();`
);

// Patch handleAnswer to log answers
simScript = simScript.replace(
  'const scoreKey = `${ti}-${qi}`;',
  `const scoreKey = \`\${ti}-\${qi}\`;
    const globalIdx = questionsDoneBefore(ti) + qi + 1;
    let logEntry = answerLog.find(a => a.ti === ti && a.qi === qi);
    if (!logEntry) {
      logEntry = { ti, qi, globalIdx, topic: topics[ti].name, attempts: 0, selectedAnswer: getSelectedAnswerText(q, key), finalCorrect: false, locked: false };
      answerLog.push(logEntry);
    }
    logEntry.attempts = attempts;
    logEntry.selectedAnswer = getSelectedAnswerText(q, key);`
);

simScript = simScript.replace(
  'if(outcome.correct){\n      locked = true;',
  `if(outcome.correct){
      logEntry.finalCorrect = true;
      logEntry.locked = true;
      locked = true;`
);

simScript = simScript.replace(
  'if(attempts>=2){\n        locked = true;',
  `if(attempts>=2){
        logEntry.finalCorrect = false;
        logEntry.locked = true;
        locked = true;`
);

// Shuffle multiple-choice options so correct answer isn't always B
simScript = simScript.replace(
  '  // ---------- QUESTION ----------\n  function renderQuestion(ti, qi){',
  `  function shuffleArray(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function getDisplayOptions(q) {
    if (!q._displayOptions) {
      q._displayOptions = shuffleArray(q.options).map((o, i) => ({
        tag: String.fromCharCode(65 + i),
        text: o.text,
        correct: o.correct,
        note: o.note
      }));
    }
    return q._displayOptions;
  }

  function clearOptionShuffleCache() {
    topics.forEach(t => t.questions.forEach(q => { delete q._displayOptions; }));
  }

  // ---------- QUESTION ----------
  function renderQuestion(ti, qi){`
);

simScript = simScript.replace(
  `      q.options.forEach((o,i)=>{
        const label = q.optsMono ? \`<code>\${o.text}</code>\` : \`<span class="plain">\${o.text}</span>\`;
        body += \`<div class="opt" data-key="\${i}"><span class="tag">\${o.tag}</span>\${label}</div>\`;
      });`,
  `      getDisplayOptions(q).forEach((o,i)=>{
        const label = q.optsMono ? \`<code>\${o.text}</code>\` : \`<span class="plain">\${o.text}</span>\`;
        body += \`<div class="opt" data-key="\${i}"><span class="tag">\${o.tag}</span>\${label}</div>\`;
      });`
);

simScript = simScript.replace(
  "if(q.kind === 'options') return q.options[key];",
  "if(q.kind === 'options') return getDisplayOptions(q)[key];"
);

simScript = simScript.replace(
  `    if (q.kind === 'options') {
      const opt = q.options[k];
      return opt ? (opt.tag + '. ' + opt.text) : '—';
    }`,
  `    if (q.kind === 'options') {
      const opt = getDisplayOptions(q)[k];
      return opt ? (opt.tag + '. ' + opt.text) : '—';
    }`
);

simScript = simScript.replace(
  '    answerLog.length = 0;\n    render();',
  '    answerLog.length = 0;\n    clearOptionShuffleCache();\n    render();'
);

simScript = simScript.replaceAll(
  'document.getElementById(\'nextBtn\').onclick = ()=> go(ptr+1);',
  `document.getElementById('nextBtn').onclick = ()=> { syncProgress(); go(ptr+1); };`
);

simScript = simScript.replace(
  'document.getElementById(\'startBtn\').onclick = ()=> go(1);',
  `document.getElementById('startBtn').onclick = ()=> { syncProgress('Topic 1'); go(1); };`
);

simScript = simScript.replace(
  'document.getElementById(\'beginTopicBtn\').onclick = ()=> go(ptr+1);',
  `document.getElementById('beginTopicBtn').onclick = ()=> { syncProgress(); go(ptr+1); };`
);

simScript = simScript.replace(
  'document.getElementById(\'continueBtn\').onclick = ()=> go(ptr+1);',
  `document.getElementById('continueBtn').onclick = ()=> { syncProgress(); go(ptr+1); };`
);

// Replace renderResults to call platform completion
simScript = simScript.replace(
  /function renderResults\(\)\{[\s\S]*?sendScoreToLMS\(pct\);\s*\}/,
  `function renderResults(){
    fxRef.textContent = 'RESULT';
    fxLabel.textContent = 'Simulation complete';
    const totalQ = totalQuestions();
    let grand = 0;
    topics.forEach((t,ti)=>{
      t.questions.forEach((q,qi)=> grand += (scores[ti+'-'+qi] || 0));
    });
    const pct = Math.round((grand/totalQ)*100);
    const timeTaken = sessionStartTime ? Math.round((Date.now() - sessionStartTime) / 1000) : 0;
    let correctCount = 0, incorrectCount = 0;
    topics.forEach((t,ti)=>{
      t.questions.forEach((q,qi)=>{
        const pts = scores[ti+'-'+qi] || 0;
        if (pts > 0) correctCount++; else incorrectCount++;
      });
    });
    const report = buildReport();
    stage.innerHTML = '<div class="note-strip">Simulation complete — loading your results…</div>';
    syncProgress('Finished');
    if (hooks.onComplete) {
      hooks.onComplete({
        finalScore: Math.round(grand * 10) / 10,
        percentage: pct,
        questionsAttempted: totalQ,
        correctCount,
        incorrectCount,
        timeTaken,
        report
      });
    }
    sendScoreToLMS(pct);
  }`
);

fs.writeFileSync(path.join(__dirname, 'public', 'js', 'simulation-engine.js'), simScript.trim());

const platformJs = fs.readFileSync(path.join(__dirname, 'platform-template.js'), 'utf8');
fs.writeFileSync(path.join(__dirname, 'public', 'js', 'platform.js'), platformJs);

const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gulf Freight Co. — Simulation Platform</title>
<style>
${styleMatch[1]}
/* Platform layer */
body.platform-login, body.platform-waiting, body.platform-sim, body.platform-complete {
  align-items:center;
  justify-content:center;
}
body.platform-trainer {
  align-items:flex-start;
  justify-content:center;
}
.view {
  display:none;
  width:100%;
  max-width:960px;
  margin:0 auto;
}
.view.active { display:block; }
#waitingView.active, #simView.active, #completeView.active {
  display:flex;
  flex-direction:column;
  align-items:center;
  width:100%;
}
#waitingView .app, #simView .app, #completeView .app {
  margin:0 auto;
  width:100%;
  max-width:780px;
}
#trainerView.active {
  display:flex;
  flex-direction:column;
  gap:16px;
  max-width:1100px;
}
.login-wrap { max-width:520px; margin:0 auto; }
.login-card { background:var(--white); border:1px solid var(--grid-line); border-radius:12px; padding:28px; box-shadow:0 4px 24px rgba(26,43,74,.08); }
.login-card h2 { margin:0 0 6px; color:var(--navy); font-size:22px; }
.login-card .lead { color:var(--slate); font-size:14px; margin:0 0 22px; line-height:1.5; }
.role-tabs { display:flex; gap:8px; margin-bottom:22px; }
.role-tab { flex:1; padding:12px; border:1.5px solid var(--grid-line); border-radius:8px; background:var(--white); cursor:pointer; font-weight:700; color:var(--slate); text-align:center; }
.role-tab.active { border-color:var(--teal); background:var(--teal-light); color:var(--navy); }
.form-group { margin-bottom:14px; }
.form-group label { display:block; font-size:12px; font-weight:700; color:var(--slate); margin-bottom:5px; text-transform:uppercase; letter-spacing:.06em; }
.form-group input { width:100%; padding:11px 12px; border:1.5px solid var(--grid-line); border-radius:7px; font-size:14px; font-family:inherit; }
.form-group input:focus { outline:none; border-color:var(--teal); }
.error-msg { color:var(--orange); font-size:13px; margin-top:10px; display:none; }
.error-msg.show { display:block; }
.waiting-box { text-align:center; padding:48px 24px; }
.waiting-box .pulse { width:14px; height:14px; border-radius:50%; background:var(--teal); display:inline-block; animation:pulse 1.4s infinite; margin-right:8px; vertical-align:middle; }
@keyframes pulse { 0%,100%{opacity:.3;transform:scale(.9)} 50%{opacity:1;transform:scale(1)} }
.waiting-box h2 { color:var(--navy); margin:16px 0 8px; }
.waiting-box p { color:var(--slate); }
.trainer-header {
  display:flex;
  flex-wrap:wrap;
  align-items:center;
  justify-content:flex-start;
  gap:12px;
  margin:0;
}
.trainer-controls { display:flex; gap:12px; flex-wrap:wrap; }
.trainer-controls .btn { min-width:140px; }
.badge { font-family:Consolas,monospace; font-size:11px; font-weight:700; padding:4px 10px; border-radius:20px; }
.badge.waiting { background:#FFF3D6; color:#B8860B; }
.badge.active { background:var(--teal-light); color:var(--teal); }
.badge.completed { background:var(--orange-light); color:var(--orange); }
.panel { background:var(--white); border:1px solid var(--grid-line); border-radius:10px; padding:18px; margin-bottom:16px; }
.panel h3 { margin:0 0 12px; font-size:16px; color:var(--navy); }
.status-waiting { color:#B8860B; font-weight:700; }
.status-progress { color:var(--teal); font-weight:700; }
.status-completed { color:var(--navy); font-weight:700; }
.highlight-row { background:var(--teal-light) !important; outline:2px solid var(--teal); }
.analytics-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; }
.stat-card { border:1px solid var(--grid-line); border-radius:8px; padding:12px; text-align:center; }
.stat-card .val { font-family:Consolas,monospace; font-size:20px; font-weight:700; color:var(--navy); }
.stat-card .lbl { font-size:11px; color:var(--slate); margin-top:4px; }
.insight-box { background:var(--teal-light); border-left:4px solid var(--teal); padding:14px 16px; border-radius:0 8px 8px 0; font-size:14px; line-height:1.6; color:var(--navy); margin-top:12px; }
.ref-panel { max-height:420px; overflow-y:auto; font-size:13px; line-height:1.6; color:var(--ink); }
.ref-panel h4 { color:var(--navy); margin:18px 0 8px; font-size:14px; }
.ref-panel p { margin:0 0 10px; color:var(--slate); }
.completion-section { margin-bottom:28px; }
.completion-section h3 { font-size:17px; color:var(--navy); margin:0 0 12px; border-bottom:2px solid var(--teal-light); padding-bottom:8px; }
.score-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; margin-bottom:16px; }
.score-item { border:1px solid var(--grid-line); border-radius:8px; padding:12px; text-align:center; }
.score-item .n { font-family:Consolas,monospace; font-size:22px; font-weight:700; color:var(--navy); }
.score-item .l { font-size:11px; color:var(--slate); margin-top:4px; }
.report-list { display:flex; flex-direction:column; gap:8px; }
.report-row { border:1px solid var(--grid-line); border-radius:7px; padding:10px 12px; font-size:13px; }
.participant-email { display:block; font-size:12px; color:var(--slate); margin-top:2px; font-family:Calibri,"Segoe UI",Arial,sans-serif; }
.report-row .qnum { font-family:Consolas,monospace; font-weight:700; color:var(--teal); margin-right:8px; }
.trainer-tabs {
  display:flex;
  gap:8px;
  margin:4px 0 0;
  flex-wrap:wrap;
}
.trainer-tab {
  padding:10px 16px;
  border:1.5px solid var(--grid-line);
  border-radius:7px;
  background:var(--white);
  cursor:pointer;
  font-size:13px;
  font-weight:700;
  color:var(--slate);
  white-space:nowrap;
}
.trainer-tab.active { border-color:var(--navy); background:var(--navy); color:var(--white); }
.tab-content { display:none; }
.tab-content.active { display:block; }
button.btn:disabled { opacity:0.45; cursor:not-allowed; }
#trainerView .ribbon { border-radius:10px; flex-shrink:0; }
#trainerView .panel { margin-bottom:0; }
@media (max-width:520px){
  .trainer-header{flex-direction:column;align-items:stretch;}
  .trainer-controls .btn { width:100%; min-width:0; }
  .trainer-tab { flex:1 1 calc(50% - 8px); text-align:center; }
}
</style>
</head>
<body class="platform-login">
<div id="loginView" class="view active login-wrap" aria-hidden="false">
  <div class="ribbon" style="border-radius:10px;margin-bottom:16px;">
    <div class="brand"><span class="mark">LP</span><div><h1>Gulf Freight Co. — HR Dashboard</h1><div class="sub">Module 2 Simulation Platform</div></div></div>
  </div>
  <div class="login-card">
    <h2>Welcome</h2>
    <p class="lead">Select your role to enter the simulation session.</p>
    <div class="role-tabs">
      <button class="role-tab active" data-role="student">Student Login</button>
      <button class="role-tab" data-role="trainer">Trainer Login</button>
    </div>
    <div id="studentForm">
      <div class="form-group"><label>Your Name</label><input type="text" id="studentName" placeholder="Enter your full name" autocomplete="name"></div>
      <div class="form-group"><label>Email</label><input type="email" id="studentId" placeholder="Enter your email" autocomplete="email"></div>
      <button class="btn primary" id="studentStartBtn" style="width:100%;margin-top:6px;">Start</button>
    </div>
    <div id="trainerForm" style="display:none;">
      <div class="form-group"><label>Trainer Access Code</label><input type="password" id="trainerCode" name="trainer-access-code" placeholder="Enter access code" autocomplete="new-password" value="" spellcheck="false" data-lpignore="true" data-form-type="other"></div>
      <button class="btn primary" id="trainerLoginBtn" style="width:100%;margin-top:6px;">Enter Dashboard</button>
    </div>
    <div class="error-msg" id="loginError"></div>
  </div>
</div>

<div id="waitingView" class="view" hidden aria-hidden="true">
  <div class="app">
    <div class="ribbon"><div class="brand"><span class="mark">LP</span><div><h1>Gulf Freight Co. — HR Dashboard</h1><div class="sub" id="waitingStudentName">Student</div></div></div></div>
    <div class="stage waiting-box">
      <span class="pulse"></span><span style="color:var(--slate);font-size:13px;">Live session</span>
      <h2>Waiting for the trainer to start the simulation…</h2>
      <p>You'll enter automatically when the trainer clicks <strong>Start Simulation</strong>. No refresh needed.</p>
    </div>
  </div>
</div>

<div id="simView" class="view" hidden aria-hidden="true">
  <div class="app">
    <div class="ribbon"><div class="brand"><span class="mark">LP</span><div><h1>Gulf Freight Co. — HR Dashboard</h1><div class="sub" id="simStudentName">Module 2 Recap Simulation · 4 Topics · 20 Questions</div></div></div></div>
    <div class="fx-bar"><span class="cell-ref" id="fxRef">START</span><span id="fxLabel">Welcome</span></div>
    <div class="stage" id="stage"></div>
  </div>
</div>

<div id="completeView" class="view" hidden aria-hidden="true">
  <div class="app" style="max-width:900px;">
    <div class="ribbon"><div class="brand"><span class="mark">LP</span><div><h1>Simulation Complete</h1><div class="sub" id="completeStudentName">Your Results</div></div></div></div>
    <div class="stage" id="completeContent"></div>
  </div>
</div>

<div id="trainerView" class="view" hidden aria-hidden="true">
  <div class="ribbon" style="border-radius:10px;">
    <div class="brand"><span class="mark">LP</span><div><h1>Trainer Dashboard</h1><div class="sub">Gulf Freight Co. — Live Session Control</div></div></div>
    <span class="badge waiting" id="sessionBadge">Waiting</span>
  </div>
  <div class="trainer-header">
    <div class="trainer-controls">
      <button class="btn primary" id="startSimBtn">Start Simulation</button>
      <button class="btn warn" id="forceCompleteBtn" disabled title="End session early and generate analytics from finished students">Force Complete</button>
      <button class="btn ghost" id="resetSessionBtn">Reset Session</button>
    </div>
  </div>
  <div class="trainer-tabs">
    <button class="trainer-tab active" data-tab="monitor">Live Monitoring</button>
    <button class="trainer-tab" data-tab="leaderboard">Final Leaderboard</button>
    <button class="trainer-tab" data-tab="analytics">Batch Analytics</button>
    <button class="trainer-tab" data-tab="reference">Trainer Reference</button>
  </div>
  <div id="tab-monitor" class="tab-content active">
    <div class="panel"><h3>Live Participant Monitoring</h3><div id="liveTable"></div></div>
  </div>
  <div id="tab-leaderboard" class="tab-content">
    <div class="panel"><h3>Session Leaderboard</h3><div id="trainerLeaderboard"></div></div>
  </div>
  <div id="tab-analytics" class="tab-content">
    <div class="panel"><h3>Facilitator Report</h3><div id="trainerAnalytics"><p class="round-brief">Analytics will appear when all participants complete the simulation.</p></div></div>
  </div>
  <div id="tab-reference" class="tab-content">
    <div class="panel"><h3>Trainer Reference</h3><div id="trainerReference" class="ref-panel"></div></div>
  </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script src="/js/simulation-engine.js"></script>
<script src="/js/platform.js"></script>
</body>
</html>`;

fs.writeFileSync(path.join(__dirname, 'public', 'index.html'), indexHtml);
console.log('Build complete.');
