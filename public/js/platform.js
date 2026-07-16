(function () {
  const socket = io();
  let role = null;
  let participantId = null;
  let studentName = '';
  let sessionData = null;

  const views = {
    login: document.getElementById('loginView'),
    waiting: document.getElementById('waitingView'),
    sim: document.getElementById('simView'),
    complete: document.getElementById('completeView'),
    trainer: document.getElementById('trainerView')
  };

  function showView(name) {
    Object.entries(views).forEach(([key, el]) => {
      const isActive = key === name;
      el.classList.toggle('active', isActive);
      el.hidden = !isActive;
      el.setAttribute('aria-hidden', isActive ? 'false' : 'true');
    });
    document.body.className = 'platform-' + name;
  }

  // Ensure only login is visible on initial load
  showView('login');
  document.getElementById('trainerCode').value = '';

  function showError(msg) {
    const el = document.getElementById('loginError');
    el.textContent = msg;
    el.classList.add('show');
  }

  function clearError() {
    const el = document.getElementById('loginError');
    el.textContent = '';
    el.classList.remove('show');
  }

  function formatTime(seconds) {
    if (seconds == null) return '—';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m + 'm ' + s + 's';
  }

  function statusClass(status) {
    if (status === 'Waiting') return 'status-waiting';
    if (status === 'Completed') return 'status-completed';
    return 'status-progress';
  }

  // Role tabs
  document.querySelectorAll('.role-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.role-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const isStudent = tab.dataset.role === 'student';
      document.getElementById('studentForm').style.display = isStudent ? 'block' : 'none';
      document.getElementById('trainerForm').style.display = isStudent ? 'none' : 'block';
      document.getElementById('trainerCode').value = '';
      clearError();
    });
  });

  document.getElementById('studentStartBtn').addEventListener('click', () => {
    clearError();
    const name = document.getElementById('studentName').value.trim();
    const studentId = document.getElementById('studentId').value.trim();
    if (!name) { showError('Please enter your name.'); return; }
    studentName = name;
    socket.emit('student:join', { name, studentId });
  });

  document.getElementById('trainerLoginBtn').addEventListener('click', () => {
    clearError();
    const code = document.getElementById('trainerCode').value.trim();
    socket.emit('trainer:join', { code });
  });

  document.getElementById('startSimBtn').addEventListener('click', () => {
    socket.emit('trainer:start');
  });

  document.getElementById('resetSessionBtn').addEventListener('click', () => {
    if (confirm('Reset the entire session? All students must log in again.')) {
      socket.emit('trainer:reset');
    }
  });

  document.querySelectorAll('.trainer-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.trainer-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  socket.on('student:joined', ({ participantId: id, session }) => {
    role = 'student';
    participantId = id;
    sessionData = session;
    document.getElementById('waitingStudentName').textContent = studentName;
    document.getElementById('simStudentName').textContent = studentName + ' · Module 2 Recap';
    if (session.status === 'active') startSimulation();
    else showView('waiting');
  });

  socket.on('trainer:joined', ({ session }) => {
    role = 'trainer';
    sessionData = session;
    showView('trainer');
    renderTrainerDashboard(session);
    loadTrainerReference();
  });

  socket.on('trainer:denied', ({ message }) => {
    showError(message || 'Invalid Access Code');
  });

  socket.on('session:update', (session) => {
    sessionData = session;
    if (role === 'student') {
      if (session.status === 'active' && views.waiting.classList.contains('active')) {
        startSimulation();
      }
      if (views.complete.classList.contains('active')) {
        renderStudentCompletion(session, lastCompleteData);
      }
    } else if (role === 'trainer') {
      renderTrainerDashboard(session);
    }
  });

  socket.on('session:reset', () => {
    role = null;
    participantId = null;
    simStarted = false;
    lastCompleteData = null;
    showView('login');
    clearError();
    document.getElementById('studentName').value = '';
    document.getElementById('studentId').value = '';
    document.getElementById('trainerCode').value = '';
  });

  socket.on('error', ({ message }) => showError(message));

  let lastCompleteData = null;
  let simStarted = false;

  function startSimulation() {
    if (simStarted) return;
    simStarted = true;
    showView('sim');
    window.SimulationEngine.init({
      onProgress(data) {
        socket.emit('student:progress', data);
      },
      onComplete(data) {
        lastCompleteData = data;
        socket.emit('student:complete', data);
        renderStudentCompletion(sessionData, data);
        showView('complete');
      }
    });
  }

  function renderStudentCompletion(session, data) {
    if (!data) return;
    const lb = (session && session.leaderboard) || [];
    const myEntry = lb.find(e => e.id === participantId);
    const rank = myEntry ? myEntry.rank : '—';

    document.getElementById('completeStudentName').textContent = studentName;

    const report = data.report || { correct: [], incorrect: [], learningSummary: '' };

    let html = '';

    // Section A
    html += '<div class="completion-section"><h3>Personal Score Dashboard</h3>';
    html += '<div class="score-grid">';
    html += scoreItem(data.finalScore, 'Final Score');
    html += scoreItem(data.percentage + '%', 'Percentage');
    html += scoreItem('#' + rank, 'Rank');
    html += scoreItem(data.questionsAttempted, 'Questions Attempted');
    html += scoreItem(data.correctCount, 'Correct Answers');
    html += scoreItem(data.incorrectCount, 'Incorrect Answers');
    html += scoreItem(formatTime(data.timeTaken), 'Time Taken');
    html += scoreItem('Completed', 'Completion Status');
    html += '</div></div>';

    // Section B
    html += '<div class="completion-section"><h3>Session Leaderboard</h3>';
    html += renderLeaderboardTable(lb, participantId);
    html += '</div>';

    // Section C
    html += '<div class="completion-section"><h3>Individual Performance Report</h3>';
    html += '<h4 style="font-size:14px;color:var(--navy);margin:16px 0 8px;">Questions Answered Correctly</h4>';
    html += '<div class="report-list">';
    if (report.correct.length) {
      report.correct.forEach(r => {
        html += '<div class="report-row"><span class="qnum">Q' + r.questionNumber + '</span><strong>' + r.topic + '</strong> — ' + escapeHtml(r.correct) + '</div>';
      });
    } else html += '<p class="round-brief">No fully correct answers recorded.</p>';
    html += '</div>';

    html += '<h4 style="font-size:14px;color:var(--navy);margin:16px 0 8px;">Questions Answered Incorrectly</h4>';
    html += '<div class="report-list">';
    if (report.incorrect.length) {
      report.incorrect.forEach(r => {
        html += '<div class="report-row"><span class="qnum">Q' + r.questionNumber + '</span><strong>' + r.topic + '</strong><br>Correct: ' + escapeHtml(r.correctAnswer) + '<br>Your answer: ' + escapeHtml(r.selectedAnswer) + '</div>';
      });
    } else html += '<p class="round-brief">Great work — no incorrect answers!</p>';
    html += '</div>';

    html += '<h4 style="font-size:14px;color:var(--navy);margin:16px 0 8px;">Learning Summary</h4>';
    html += '<div class="insight-box">' + escapeHtml(report.learningSummary || 'Review your performance and revisit weak topic areas.') + '</div>';
    html += '</div>';

    document.getElementById('completeContent').innerHTML = html;
  }

  function scoreItem(n, label) {
    return '<div class="score-item"><div class="n">' + n + '</div><div class="l">' + label + '</div></div>';
  }

  function formatStudentName(name, email) {
    let html = '<span class="student-name">' + escapeHtml(name) + '</span>';
    if (email) html += '<span class="participant-email">' + escapeHtml(email) + '</span>';
    return html;
  }

  function renderLeaderboardTable(lb, highlightId) {
    if (!lb.length) return '<p class="round-brief">No completed participants yet. Leaderboard updates automatically as students finish.</p>';
    let html = '<table class="grid"><thead><tr><th>Rank</th><th>Participant Name</th><th>Final Score</th><th>Percentage</th><th>Time Taken</th></tr></thead><tbody>';
    lb.forEach(row => {
      const cls = row.id === highlightId ? ' class="highlight-row"' : '';
      html += '<tr' + cls + '><td>' + row.rank + '</td><td>' + formatStudentName(row.name, row.studentId) + '</td><td class="num">' + row.finalScore + '</td><td class="num">' + row.percentage + '%</td><td>' + formatTime(row.timeTaken) + '</td></tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  function renderTrainerDashboard(session) {
    const badge = document.getElementById('sessionBadge');
    badge.textContent = session.status.charAt(0).toUpperCase() + session.status.slice(1);
    badge.className = 'badge ' + session.status;

    document.getElementById('startSimBtn').disabled = session.status !== 'waiting';

    const participants = session.participants || [];
    let liveHtml = '<table class="grid"><thead><tr><th>Student Name</th><th>Status</th><th>Current Question</th><th>Questions Attempted</th><th>Current Score</th><th>Completion %</th></tr></thead><tbody>';
    if (!participants.length) {
      liveHtml += '<tr><td colspan="6" style="text-align:center;color:var(--slate);">No participants connected yet.</td></tr>';
    } else {
      participants.forEach(p => {
        liveHtml += '<tr><td>' + formatStudentName(p.name, p.studentId) + '</td><td class="' + statusClass(p.status) + '">' + p.status + '</td><td>' + escapeHtml(p.currentQuestion) + '</td><td class="num">' + p.questionsAttempted + '</td><td class="num">' + (p.currentScore ?? '—') + '</td><td class="num">' + p.completionPct + '%</td></tr>';
      });
    }
    liveHtml += '</tbody></table>';
    document.getElementById('liveTable').innerHTML = liveHtml;

    document.getElementById('trainerLeaderboard').innerHTML = renderLeaderboardTable(session.leaderboard || [], null);

    const analyticsEl = document.getElementById('trainerAnalytics');
    if (session.analytics) {
      const a = session.analytics;
      let html = '<div class="analytics-grid">';
      html += statCard(a.overall.totalParticipants, 'Total Participants');
      html += statCard(a.overall.averageScore, 'Average Score');
      html += statCard(a.overall.highestScore, 'Highest Score');
      html += statCard(a.overall.lowestScore, 'Lowest Score');
      html += statCard(formatTime(a.overall.averageCompletionTime), 'Avg Completion Time');
      html += statCard(a.overall.averageAccuracy + '%', 'Average Accuracy');
      html += '</div>';

      html += '<h4 style="margin-top:20px;color:var(--navy);">Question-wise Analysis</h4>';
      html += '<table class="grid"><thead><tr><th>Question</th><th>Attempts</th><th>Correct</th><th>Incorrect</th><th>Accuracy</th></tr></thead><tbody>';
      a.questionAnalysis.forEach(q => {
        const weak = a.weakestQuestions.some(w => w.questionNumber === q.questionNumber);
        html += '<tr' + (weak ? ' style="background:var(--orange-light);"' : '') + '><td>Q' + q.questionNumber + '</td><td class="num">' + q.totalAttempts + '</td><td class="num">' + q.correctResponses + '</td><td class="num">' + q.incorrectResponses + '</td><td class="num">' + q.accuracy + '%</td></tr>';
      });
      html += '</tbody></table>';

      html += '<h4 style="margin-top:20px;color:var(--navy);">Topic-wise Analysis</h4><div class="report-list">';
      a.topicAnalysis.forEach(t => {
        const weak = t.averageAccuracy < 60;
        html += '<div class="report-row"' + (weak ? ' style="border-color:var(--orange);"' : '') + '><strong>' + t.topic + '</strong> — Average Accuracy: ' + t.averageAccuracy + '%' + (weak ? ' <span style="color:var(--orange);">(needs reinforcement)</span>' : '') + '</div>';
      });
      html += '</div>';

      html += '<h4 style="margin-top:20px;color:var(--navy);">Common Mistakes</h4><ul class="topics-list">';
      a.commonMistakes.forEach(m => { html += '<li style="font-size:13.5px;color:var(--slate);margin-bottom:6px;">' + escapeHtml(m) + '</li>'; });
      html += '</ul>';

      html += '<h4 style="margin-top:20px;color:var(--navy);">Facilitator Insights</h4>';
      html += '<div class="insight-box">' + escapeHtml(a.facilitatorInsights) + '</div>';
      analyticsEl.innerHTML = html;
    } else {
      analyticsEl.innerHTML = '<p class="round-brief">Analytics will appear when all participants complete the simulation.</p>';
    }
  }

  function statCard(val, label) {
    return '<div class="stat-card"><div class="val">' + val + '</div><div class="lbl">' + label + '</div></div>';
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function loadTrainerReference() {
    fetch('/trainer-reference.html')
      .then(r => r.text())
      .then(html => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        document.getElementById('trainerReference').innerHTML = doc.body.innerHTML;
      })
      .catch(() => {
        document.getElementById('trainerReference').innerHTML = '<p>Trainer reference document could not be loaded. Please ensure trainer-reference.html is available.</p>';
      });
  }
})();
