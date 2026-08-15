const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, '../data.json');

let db = {
  config: {
    examCode: "BCC2026",
    engPassage: "The quick brown fox jumps over the lazy dog. Fast typing requires practice and precision.",
    bnPassage: "আমাদের বাংলাদেশের প্রাকৃতিক সৌন্দর্য অপরূপ। বাংলা ভাষায় সঠিক ও দ্রুত টাইপিং জানা অত্যন্ত প্রয়োজনীয়।",
    duration: 5,
    engMinPassWpm: 20,
    bnMinPassWpm: 15,
    adminPassword: "admin",
    securityQuestion: "আপনার প্রিয় রঙ কোনটি?",
    securityAnswer: "blue"
  },
  approvedRolls: [], // এডমিন প্যানেল থেকে অনুমোদিত রোলসমূহের তালিকা
  completedRolls: {}, // কোন রোল কোন এক্সাম কোডে পরীক্ষা দিয়েছে তার রেকর্ড (examCode_candidateId -> true)
  results: [],
  activeSessions: {}
};

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
  }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

loadData();

app.get('/api/exam-config', (req, res) => {
  res.json({
    duration: db.config.duration,
    engPassage: db.config.engPassage,
    bnPassage: db.config.bnPassage,
    securityQuestion: db.config.securityQuestion
  });
});

// পরীক্ষার্থী ভ্যালিডেশন এবং রোল অনুমোদন ও পুনরায় পরীক্ষা চেক
app.post('/api/validate-candidate', (req, res) => {
  const { candidateId, examCode } = req.body;
  if (examCode !== db.config.examCode) {
    return res.json({ success: false, message: "ভুল পরীক্ষা কোড (Exam Code)!" });
  }

  // ১. এডমিন কর্তৃক রোল অনুমোদিত হতে হবে
  if (!db.approvedRolls || !db.approvedRolls.includes(candidateId)) {
    return res.json({ success: false, message: "এই রোল নম্বরটি পরীক্ষার জন্য অনুমোদিত নয়। অনুগ্রহ করে অ্যাডমিনের সাথে যোগাযোগ করুন।" });
  }

  // ২. একই এক্সাম কোডে ইতিমধ্যে পরীক্ষা সম্পন্ন করেছে কিনা চেক
  const recordKey = `${examCode}_${candidateId}`;
  const isCompleted = db.completedRolls && db.completedRolls[recordKey];

  if (isCompleted) {
    // সেশন সেভ করা থাকলে (যদি ব্র্যাকগ্রাউন্ডে আটকে থাকে) সেটা দেওয়া যাবে, না হলে অলরেডি সাবমিটেড দেখাবে
    const session = db.activeSessions[candidateId];
    if (!session) {
      return res.json({ success: false, message: "এই রোল নম্বর দিয়ে ইতিমধ্যে এই পরীক্ষায় অংশগ্রহণ করা হয়েছে। পুনরায় টাইপ করার জন্য অ্যাডমিনের অনুমতি প্রয়োজন।" });
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
  const { candidateId, candidateName, step, engText, bnText, engTimeLeft, bnTimeLeft } = req.body;
  db.activeSessions[candidateId] = { candidateId, candidateName, step, engText, bnText, engTimeLeft, bnTimeLeft };
  saveData();
  res.json({ success: true });
});

function calculateMetrics(original, typed, durationMin, minPassWpm) {
  const origWords = original.trim().split(/\s+/);
  const typedWords = typed.trim().split(/\s+/).filter(w => w.length > 0);
  
  let correctWords = 0;
  let errors = 0;

  typedWords.forEach((word, idx) => {
    if (origWords[idx] === word) {
      correctWords++;
    } else {
      errors++;
    }
  });

  const totalWords = typedWords.length;
  const accuracy = totalWords > 0 ? ((correctWords / totalWords) * 100).toFixed(1) : 100;
  const errorPercent = totalWords > 0 ? ((errors / totalWords) * 100).toFixed(1) : 0;
  
  const grossWpm = durationMin > 0 ? Math.round(totalWords / durationMin) : 0;
  const netWpm = durationMin > 0 ? Math.max(0, Math.round((correctWords - errors) / durationMin)) : 0;
  
  const isPassed = parseFloat(errorPercent) < 5.0 && netWpm >= minPassWpm;

  return {
    totalWords,
    correctWords,
    errors,
    accuracy,
    errorPercent,
    grossWpm,
    netWpm,
    passed: isPassed
  };
}

app.post('/api/submit-exam', (req, res) => {
  const { candidateId, candidateName, engText, bnText } = req.body;

  const engRes = calculateMetrics(db.config.engPassage, engText || '', db.config.duration, db.config.engMinPassWpm);
  const bnRes = calculateMetrics(db.config.bnPassage, bnText || '', db.config.duration, db.config.bnMinPassWpm);

  // সুন্দর ফরম্যাটে জমার সময় তৈরি (তারিখ ও সময়)
  const now = new Date();
  const submissionTime = now.toLocaleString('bn-BD', { hour12: true });

  const finalResult = {
    candidateId,
    candidateName,
    examCode: db.config.examCode,
    submittedAt: submissionTime,
    engText,
    bnText,
    english: engRes,
    bangla: bnRes,
    overallPassed: engRes.passed && bnRes.passed
  };

  db.results.unshift(finalResult);
  
  // রোলটি সম্পন্ন হয়েছে মার্ক করে রাখা
  if(!db.completedRolls) db.completedRolls = {};
  db.completedRolls[`${db.config.examCode}_${candidateId}`] = true;

  delete db.activeSessions[candidateId];
  saveData();

  io.emit('exam_submitted', finalResult);
  res.json({ success: true });
});

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === db.config.adminPassword) res.json({ success: true });
  else res.json({ success: false, message: "ভুল পাসওয়ার্ড!" });
});

app.get('/api/admin/full-config', (req, res) => {
  res.json({
    ...db.config,
    approvedRolls: db.approvedRolls || []
  });
});

app.post('/api/admin/update-config', (req, res) => {
  const { examCode, engPassage, bnPassage, duration, engMinPassWpm, bnMinPassWpm, currPass, newPass, secQ, currSecAns, newSecAns, approvedRolls } = req.body;

  if (currPass && currPass !== db.config.adminPassword) {
    return res.json({ success: false, message: "বর্তমান পাসওয়ার্ড ভুল!" });
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

  if (approvedRolls !== undefined) {
    // কমা বা নতুন লাইন দিয়ে আলাদা করা রোলগুলোকে অ্যারেতে রূপান্তর
    db.approvedRolls = approvedRolls.split(/[\n,]+/).map(r => r.trim()).filter(r => r.length > 0);
  }

  if (newPass) db.config.adminPassword = newPass;
  if (secQ) db.config.securityQuestion = secQ;
  if (newSecAns) db.config.securityAnswer = newSecAns;

  saveData();
  res.json({ success: true, message: "সেটিংস সফলভাবে সেভ হয়েছে!" });
});

// পুনরায় টাইপ করার অনুমতি (completedRolls এবং activeSessions থেকে রিমুভ করা)
app.post('/api/admin/reset-session', (req, res) => {
  const { candidateId } = req.body;
  if(!candidateId) return res.json({ success: false, message: "রোল নম্বর দিন।" });

  const recordKey = `${db.config.examCode}_${candidateId}`;
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
    res.json({ success: true, message: `রোল ${candidateId}-কে পুনরায় টাইপ করার অনুমতি দেওয়া হয়েছে।` });
  } else {
    res.json({ success: false, message: "এই রোলের কোনোভুল বা সক্রিয় রেকর্ড পাওয়া যায়নি, তবে রোলটি অনুমোদিত লিস্টে আছে কিনা নিশ্চিত করুন।" });
  }
});

app.get('/api/admin/security-question', (req, res) => res.json({ question: db.config.securityQuestion }));

app.post('/api/admin/recover-password', (req, res) => {
  const { answer, newPassword } = req.body;
  if (answer === db.config.securityAnswer) {
    db.config.adminPassword = newPassword;
    saveData();
    res.json({ success: true, message: "পাসওয়ার্ড সফলভাবে রিকভার হয়েছে!" });
  } else res.json({ success: false, message: "ভুল সিকিউরিটি উত্তর!" });
});

app.get('/api/results', (req, res) => res.json(db.results));

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

server.listen(3000, () => console.log('Server running on http://localhost:3000'));