const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

// স্ট্যাটিক ফাইল এবং রুট ডিরেক্টরি সঠিকভাবে সেট করা
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data.json');

let db = {
  config: {
    examCode: "BCC2026",
    engPassage: "The quick brown fox jumps over the lazy dog. Fast typing requires practice and precision.",
    bnPassage: "আমাদের বাংলাদেশের প্রাকৃতিক সৌন্দর্য অপরূপ। বাংলা ভাষায় সঠিক ও দ্রুত টাইপিং জানা অত্যন্ত প্রয়োজনীয়।",
    duration: 5,
    engMinPassWpm: 20,
    bnMinPassWpm: 15,
    adminPassword: "admin",
    securityQuestion: "আপনার প্রিয় রঙ কোনটি?",
    securityAnswer: "blue"
  },
  // rollSettings format: { "101": { expiryTime: "2026-12-31T23:59", isBlocked: false, allowedExamCodes: ["BCC2026"] } }
  rollSettings: {}, 
  completedRolls: {}, 
  results: [],
  activeSessions: {}
};

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try { 
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      db = { ...db, ...data };
    } catch (e) {
      console.error("Data load error:", e);
    }
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error("Data save error:", e);
  }
}

loadData();

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/exam-config', (req, res) => {
  res.json({
    duration: db.config.duration,
    engPassage: db.config.engPassage,
    bnPassage: db.config.bnPassage,
    securityQuestion: db.config.securityQuestion
  });
});

// পরীক্ষার্থী ভ্যালিডেশন: রোল, নির্দিষ্ট পরীক্ষা কোড, ব্লক ও মেয়াদ চেক
app.post('/api/validate-candidate', (req, res) => {
  const { candidateId, examCode } = req.body;
  
  const rollInfo = db.rollSettings[candidateId];

  // ১. রোল রেজিস্টার্ড বা এন্ট্রি করা আছে কিনা চেক
  if (!rollInfo) {
    return res.json({ success: false, message: "এই রোল নম্বরটি সিস্টেমে নিবন্ধিত নয়।" });
  }

  // ২. নির্দিষ্ট রোলের জন্য উক্ত পরীক্ষা কোড অনুমোদিত কিনা চেক
  const allowedCodes = rollInfo.allowedExamCodes || [db.config.examCode];
  if (!allowedCodes.includes(examCode)) {
    return res.json({ success: false, message: "এই রোল নম্বরের জন্য এই পরীক্ষা কোডটি অনুমোদিত নয়।" });
  }

  // ৩. রোল ব্লক করা আছে কিনা চেক
  if (rollInfo.isBlocked) {
    return res.json({ success: false, message: "এই রোল নম্বরটি বর্তমানে ব্লক করা রয়েছে। অ্যাডমিনের সাথে যোগাযোগ করুন।" });
  }

  // ৪. নির্দিষ্ট সময়সীমা বা মেয়াদ উত্তীর্ণ (Expiry Time) চেক
  if (rollInfo.expiryTime) {
    const now = new Date();
    const expiry = new Date(rollInfo.expiryTime);
    if (now > expiry) {
      return res.json({ success: false, message: "এই রোল নম্বরের পরীক্ষার সময়সীমা (Expiry Time) পার হয়ে গেছে।" });
    }
  }

  // ৫. ইতিমধ্যে পরীক্ষা সম্পন্ন করেছে কিনা চেক
  const recordKey = `${examCode}_${candidateId}`;
  const isCompleted = db.completedRolls && db.completedRolls[recordKey];

  if (isCompleted) {
    const session = db.activeSessions[candidateId];
    if (!session) {
      return res.json({ success: false, message: "এই রোল নম্বর দিয়ে ইতিমধ্যে পরীক্ষা সম্পন্ন হয়েছে। পুনরায় অংশগ্রহণের জন্য অ্যাডমিনের অনুমতি প্রয়োজন।" });
    }
  }

  const session = db.activeSessions[candidateId];
  res.json({ 
    success: true, 
    hasSavedSession: !!session, 
    sessionData: session || null 
  });
});

app.post('/api/save-progress', (req, res) => {
  const { candidateId, candidateName, step, engText, bnText, engTimeLeft, bnTimeLeft, currentWpm, currentAccuracy } = req.body;
  
  db.activeSessions[candidateId] = { 
    candidateId, 
    candidateName, 
    step, 
    engText, 
    bnText, 
    engTimeLeft, 
    bnTimeLeft,
    currentWpm: currentWpm || 0,
    currentAccuracy: currentAccuracy || 100,
    lastUpdated: new Date().toLocaleTimeString()
  };
  
  saveData();
  io.emit('live_progress_update', db.activeSessions[candidateId]);
  res.json({ success: true });
});

function calculateMetrics(original, typed, durationMin, minPassWpm) {
  const cleanTyped = typed || "";
  const totalChars = cleanTyped.length;
  const standardWords = totalChars / 5;

  const origWords = original.trim().split(/\s+/);
  const typedWords = cleanTyped.trim().split(/\s+/).filter(w => w.length > 0);
  
  let correctWords = 0;
  let errors = 0;

  typedWords.forEach((word, idx) => {
    if (origWords[idx] && origWords[idx] === word) {
      correctWords++;
    } else {
      errors++;
    }
  });

  const totalTypedCount = typedWords.length;
  const accuracy = totalTypedCount > 0 ? ((correctWords / totalTypedCount) * 100).toFixed(1) : 100;
  const errorPercent = totalTypedCount > 0 ? ((errors / totalTypedCount) * 100).toFixed(1) : 0;
  
  const grossWpm = durationMin > 0 ? Math.round(standardWords / durationMin) : 0;
  const netWpm = durationMin > 0 ? Math.max(0, Math.round((correctWords / durationMin) - (errors / durationMin))) : 0;
  
  const isPassed = parseFloat(errorPercent) < 5.0 && netWpm >= minPassWpm;

  return {
    totalWords: Math.round(standardWords),
    correctWords,
    errors,
    accuracy: parseFloat(accuracy),
    errorPercent: parseFloat(errorPercent),
    grossWpm,
    netWpm,
    passed: isPassed
  };
}

app.post('/api/submit-exam', (req, res) => {
  const { candidateId, candidateName, examCode, engText, bnText } = req.body;
  const currentExamCode = examCode || db.config.examCode;

  const engRes = calculateMetrics(db.config.engPassage, engText || '', db.config.duration, db.config.engMinPassWpm);
  const bnRes = calculateMetrics(db.config.bnPassage, bnText || '', db.config.duration, db.config.bnMinPassWpm);

  const now = new Date();
  const submissionTime = now.toLocaleString('bn-BD', { hour12: true });

  const finalResult = {
    candidateId,
    candidateName,
    examCode: currentExamCode,
    submittedAt: submissionTime,
    engText,
    bnText,
    english: engRes,
    bangla: bnRes,
    overallPassed: engRes.passed && bnRes.passed
  };

  db.results.unshift(finalResult);
  
  if (!db.completedRolls) db.completedRolls = {};
  db.completedRolls[`${currentExamCode}_${candidateId}`] = true;

  delete db.activeSessions[candidateId];
  saveData();

  io.emit('exam_submitted', finalResult);
  res.json({ success: true, result: finalResult });
});

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === db.config.adminPassword) res.json({ success: true });
  else res.json({ success: false, message: "ভুল পাসওয়ার্ড!" });
});

app.get('/api/admin/full-config', (req, res) => {
  res.json({
    ...db.config,
    rollSettings: db.rollSettings || {}
  });
});

app.post('/api/admin/update-config', (req, res) => {
  const { 
    examCode, engPassage, bnPassage, duration, engMinPassWpm, bnMinPassWpm, 
    currPass, newPass, secQ, currSecAns, newSecAns, rollUpdates, newRolls 
  } = req.body;

  if (currPass && currPass !== db.config.adminPassword) {
    return res.json({ success: false, message: "বর্তমান পাসওয়ার্ড ভুল!" });
  }
  if (currSecAns && currSecAns !== db.config.securityAnswer) {
    return res.json({ success: false, message: "বর্তমান সিকিউরিটি উত্তর ভুল!" });
  }

  if (examCode) db.config.examCode = examCode;
  if (engPassage) db.config.engPassage = engPassage;
  if (bnPassage) db.config.bnPassage = bnPassage;
  if (duration) db.config.duration = parseInt(duration);
  if (engMinPassWpm) db.config.engMinPassWpm = parseInt(engMinPassWpm);
  if (bnMinPassWpm) db.config.bnMinPassWpm = parseInt(bnMinPassWpm);

  // রোল আপডেট (ব্লক/আনব্লক, এক্সপায়ারি টাইম এবং অনুমোদিত পরীক্ষা কোড সহ)
  if (rollUpdates && Array.isArray(rollUpdates)) {
    rollUpdates.forEach(item => {
      const { roll, expiryTime, isBlocked, allowedExamCodes } = item;
      if (roll) {
        if (!db.rollSettings[roll]) {
          db.rollSettings[roll] = { expiryTime: "", isBlocked: false, allowedExamCodes: [db.config.examCode] };
        }
        if (expiryTime !== undefined) db.rollSettings[roll].expiryTime = expiryTime;
        if (isBlocked !== undefined) db.rollSettings[roll].isBlocked = isBlocked;
        if (allowedExamCodes !== undefined) {
          db.rollSettings[roll].allowedExamCodes = Array.isArray(allowedExamCodes) 
            ? allowedExamCodes 
            : allowedExamCodes.split(',').map(c => c.trim()).filter(c => c.length > 0);
        }
      }
    });
  }

  // নতুন রোল যোগ করার টেক্সট প্রসেসিং
  if (newRolls) {
    const list = newRolls.split(/[\n,]+/).map(r => r.trim()).filter(r => r.length > 0);
    list.forEach(r => {
      if (!db.rollSettings[r]) {
        db.rollSettings[r] = { expiryTime: "", isBlocked: false, allowedExamCodes: [db.config.examCode] };
      }
    });
  }

  if (newPass) db.config.adminPassword = newPass;
  if (secQ) db.config.securityQuestion = secQ;
  if (newSecAns) db.config.securityAnswer = newSecAns;

  saveData();
  res.json({ success: true, message: "সেটিংস ও রোল ম্যানেজমেন্ট সফলভাবে আপডেট হয়েছে!" });
});

app.post('/api/admin/delete-roll', (req, res) => {
  const { roll } = req.body;
  if (db.rollSettings[roll]) {
    delete db.rollSettings[roll];
    saveData();
    return res.json({ success: true, message: `রোল ${roll} মুছে ফেলা হয়েছে।` });
  }
  res.json({ success: false, message: "রোলটি পাওয়া যায়নি।" });
});

app.post('/api/admin/reset-session', (req, res) => {
  const { candidateId, examCode } = req.body;
  if(!candidateId) return res.json({ success: false, message: "রোল নম্বর দিন।" });

  const targetExamCode = examCode || db.config.examCode;
  const recordKey = `${targetExamCode}_${candidateId}`;
  let cleared = false;

  if (db.activeSessions[candidateId]) {
    delete db.activeSessions[candidateId];
    cleared = true;
  }
  if (db.completedRolls && db.completedRolls[recordKey]) {
    delete db.completedRolls[recordKey];
    cleared = true;
  }

  if (cleared) {
    saveData();
    res.json({ success: true, message: `রোল ${candidateId}-কে পুনরায় টাইপ করার অনুমতি দেওয়া হয়েছে।` });
  } else {
    res.json({ success: false, message: "এই রোলের কোনো সক্রিয় বা সম্পন্ন রেকর্ড পাওয়া যায়নি।" });
  }
});

app.get('/api/admin/security-question', (req, res) => res.json({ question: db.config.securityQuestion }));

app.post('/api/admin/recover-password', (req, res) => {
  const { answer, newPassword } = req.body;
  if (answer === db.config.securityAnswer) {
    db.config.adminPassword = newPassword;
    saveData();
    res.json({ success: true, message: "পাসওয়ার্ড সফলভাবে রিকভার হয়েছে!" });
  } else res.json({ success: false, message: "ভুল সিকিউরিটি উত্তর!" });
});

// ফিল্টার সহ রেজাল্ট ফেচ করার রুট (যেমন: নির্দিষ্ট পরীক্ষা কোড বা রোল অনুযায়ী)
app.get('/api/results', (req, res) => {
  let filteredResults = db.results;
  const { examCodes, rolls } = req.query;

  if (examCodes) {
    const codes = examCodes.split(',').map(c => c.trim()).filter(c => c.length > 0);
    filteredResults = filteredResults.filter(r => codes.includes(r.examCode));
  }

  if (rolls) {
    const rollList = rolls.split(',').map(r => r.trim()).filter(r => r.length > 0);
    filteredResults = filteredResults.filter(r => rollList.includes(r.candidateId));
  }

  res.json(filteredResults);
});

app.delete('/api/results/:index', (req, res) => {
  const idx = parseInt(req.params.index);
  if (idx >= 0 && idx < db.results.length) {
    db.results.splice(idx, 1);
    saveData();
  }
  res.json({ success: true });
});

app.delete('/api/results', (req, res) => {
  db.results = [];
  db.completedRolls = {};
  saveData();
  res.json({ success: true });
});

app.get('/api/admin/active-sessions', (req, res) => {
  res.json(db.activeSessions);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
