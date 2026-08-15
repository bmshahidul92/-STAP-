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
  // প্রতিটি রোলের জন্য নির্দিষ্ট এক্সপায়ারি সময় এবং ব্লক স্ট্যাটাস রাখার স্ট্রাকচার
  // rollSettings format: { "101": { expiryTime: "2026-12-31T23:59", isBlocked: false } }
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

// রুট বা হোমপেজে সরাসরি index.html দেখানোর জন্য রাউট
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

// পরীক্ষার্থী ভ্যালিডেশন: ব্লক চেক, মেয়াদ (Expiry Time) চেক এবং রোল চেক
app.post('/api/validate-candidate', (req, res) => {
  const { candidateId, examCode } = req.body;
  
  if (examCode !== db.config.examCode) {
    return res.json({ success: false, message: "ভুল পরীক্ষা কোড (Exam Code)!" });
  }

  const rollInfo = db.rollSettings[candidateId];

  // ১. রোল রেজিস্টার্ড বা এন্ট্রি করা আছে কিনা চেক
  if (!rollInfo) {
    return res.json({ success: false, message: "এই রোল নম্বরটি সিস্টেমে নিবন্ধিত নয়।" });
  }

  // ২. রোল ব্লক করা আছে কিনা চেক (অনুমোদনের বদলে ব্লক/আনব্লক লজিক)
  if (rollInfo.isBlocked) {
    return res.json({ success: false, message: "এই রোল নম্বরটি বর্তমানে ব্লক করা রয়েছে। অ্যাডমিনের সাথে যোগাযোগ করুন।" });
  }

  // ৩. নির্দিষ্ট সময়সীমা বা মেয়াদ উত্তীর্ণ (Expiry Time) চেক
  if (rollInfo.expiryTime) {
    const now = new Date();
    const expiry = new Date(rollInfo.expiryTime);
    if (now > expiry) {
      return res.json({ success: false, message: "এই রোল নম্বরের পরীক্ষার সময়সীমা (Expiry Time) পার হয়ে গেছে।" });
    }
  }

  // ৪. ইতিমধ্যে পরীক্ষা সম্পন্ন করেছে কিনা চেক
  const recordKey = `${examCode}_${candidateId}`;
  const isCompleted = db.completedRolls && db.completedRolls[recordKey];

  if (isCompleted) {
    const session = db.activeSessions[candidateId];
    if (!session) {
      return res.json({ success: false, message: "এই রোল নম্বর দিয়ে ইতিমধ্যে পরীক্ষা সম্পন্ন হয়েছে। পুনরায় অংশগ্রহণের জন্য অ্যাডমিনের অনুমতি প্রয়োজন।" });
    }
  }

  const session = db.activeSessions[candidateId];
  res.json({ 
    success: true, 
    hasSavedSession: !!session, 
    sessionData: session || null 
  });
});

// লাইভ টাইপিং প্রগ্রেস সেভ ও ব্রডকাস্ট করার জন্য Socket.io ইন্টিগ্রেশন
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

  // রিয়েল-টাইমে অ্যাডমিন প্যানেলে বা লিডারবোর্ডে পাঠানোর জন্য
  io.emit('live_progress_update', db.activeSessions[candidateId]);

  res.json({ success: true });
});

// নিখুঁত ক্যালকুলেশন লজিক (৫ স্ট্রোক = ১ শব্দ এবং যথাযথ ওয়ার্ড ম্যাচিং)
function calculateMetrics(original, typed, durationMin, minPassWpm) {
  const cleanTyped = typed || "";
  const totalChars = cleanTyped.length; // মোট স্ট্রোক বা ক্যারেক্টার
  
  const standardWords = totalChars / 5; // ৫ ক্যারেক্টারে ১ স্ট্যান্ডার্ড শব্দ

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
  
  // গ্রস এবং নেট ডব্লিউপিএম হিসাব
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

// অটো-সাবমিট বা নরমাল সাবমিট রুট
app.post('/api/submit-exam', (req, res) => {
  const { candidateId, candidateName, engText, bnText } = req.body;

  const engRes = calculateMetrics(db.config.engPassage, engText || '', db.config.duration, db.config.engMinPassWpm);
  const bnRes = calculateMetrics(db.config.bnPassage, bnText || '', db.config.duration, db.config.bnMinPassWpm);

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
  
  if (!db.completedRolls) db.completedRolls = {};
  db.completedRolls[`${db.config.examCode}_${candidateId}`] = true;

  delete db.activeSessions[candidateId];
  saveData();

  // সাবমিট হওয়ার পর লাইভ ইভেন্ট পাঠানো
  io.emit('exam_submitted', finalResult);
  res.json({ success: true, result: finalResult });
});

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === db.config.adminPassword) res.json({ success: true });
  else res.json({ success: false, message: "ভুল পাসওয়ার্ড!" });
});

// অ্যাডমিন প্যানেলের জন্য ফুল কনফিগ এবং রোল লিস্ট প্রদান
app.get('/api/admin/full-config', (req, res) => {
  res.json({
    ...db.config,
    rollSettings: db.rollSettings || {}
  });
});

// অ্যাডমিন প্যানেল থেকে কনফিগ, রোল এক্সপায়ারি ও ব্লক/আনব্লক আপডেট
app.post('/api/admin/update-config', (req, res) => {
  const { 
    examCode, engPassage, bnPassage, duration, engMinPassWpm, bnMinPassWpm, 
    currPass, newPass, secQ, currSecAns, newSecAns, rollUpdates 
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

  // রোল আপডেট (ব্লক/আনব্লক এবং এক্সপায়ারি টাইম সহ)
  if (rollUpdates && Array.isArray(rollUpdates)) {
    rollUpdates.forEach(item => {
      const { roll, expiryTime, isBlocked } = item;
      if (roll) {
        if (!db.rollSettings[roll]) {
          db.rollSettings[roll] = { expiryTime: "", isBlocked: false };
        }
        if (expiryTime !== undefined) db.rollSettings[roll].expiryTime = expiryTime;
        if (isBlocked !== undefined) db.rollSettings[roll].isBlocked = isBlocked;
      }
    });
  }

  // নতুন রোল যোগ করার টেক্সট প্রসেসিং যদি আসে
  if (req.body.newRolls) {
    const list = req.body.newRolls.split(/[\n,]+/).map(r => r.trim()).filter(r => r.length > 0);
    list.forEach(r => {
      if (!db.rollSettings[r]) {
        db.rollSettings[r] = { expiryTime: "", isBlocked: false };
      }
    });
  }

  if (newPass) db.config.adminPassword = newPass;
  if (secQ) db.config.securityQuestion = secQ;
  if (newSecAns) db.config.securityAnswer = newSecAns;

  saveData();
  res.json({ success: true, message: "সেটিংস ও রোল ম্যানেজমেন্ট সফলভাবে আপডেট হয়েছে!" });
});

// নির্দিষ্ট রোল ডিলিট বা রোল ডাটা ম্যানেজ করার রুট
app.post('/api/admin/delete-roll', (req, res) => {
  const { roll } = req.body;
  if (db.rollSettings[roll]) {
    delete db.rollSettings[roll];
    saveData();
    return res.json({ success: true, message: `রোল ${roll} মুছে ফেলা হয়েছে।` });
  }
  res.json({ success: false, message: "রোলটি পাওয়া যায়নি।" });
});

// পুনরায় পরীক্ষা বা সেশন রিসেট করার রুট
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

// লাইভ লিডারবোর্ডের জন্য সক্রিয় সেশন ডেটা দেখার এপিআই
app.get('/api/admin/active-sessions', (req, res) => {
  res.json(db.activeSessions);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
