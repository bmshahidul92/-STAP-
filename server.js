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
    adminPassword: "632750",
    securityQuestion: "আপনার প্রিয় রঙ কোনটি?",
    securityAnswer: "blue"
  },
  // mobileSettings format: { "01711223344": { expiryTime: "2026-12-31T23:59", isBlocked: false, allowedExamCodes: ["BCC2026"] } }
  mobileSettings: {}, 
  completedMobiles: {}, 
  results: [],
  activeSessions: {}
};

// পার্মানেন্ট ডাটা লোড করার নিরাপদ ফাংশন
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const fileData = fs.readFileSync(DATA_FILE, 'utf8');
      if (fileData.trim() !== '') {
        const parsedData = JSON.parse(fileData);
        db = { ...db, ...parsedData };
        
        // অ্যাডমিন পাসওয়ার্ড ও কনফিগ সুরক্ষিত রাখা
        if (!db.config) db.config = {};
        db.config.adminPassword = "632750";
        if (!db.config.securityQuestion) db.config.securityQuestion = "আপনার প্রিয় রঙ কোনটি?";
        if (!db.config.securityAnswer) db.config.securityAnswer = "blue";
        
        // পুরানো rollSettings বা completedRolls থাকলে সেগুলোকে মোবাইল সেটিংসে কনভার্ট বা ব্যাকআপ রাখা
        if (!db.mobileSettings) {
          db.mobileSettings = db.rollSettings || {};
        }
        if (!db.completedMobiles) {
          db.completedMobiles = db.completedRolls || {};
        }
        if (!db.results) db.results = [];
        if (!db.activeSessions) db.activeSessions = {};
      }
    } else {
      saveData();
    }
  } catch (e) {
    console.error("Data load error:", e);
  }
}

// পার্মানেন্ট ডাটা সেভ করার ফাংশন
function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error("Data save error:", e);
  }
}

// সার্ভার চালুর শুরুতেই ডাটা লোড
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

// পরীক্ষার্থী ভ্যালিডেশন: মোবাইল নম্বর, পরীক্ষা কোড, ব্লক ও মেয়াদ চেক
app.post('/api/validate-candidate', (req, res) => {
  const { candidateId, examCode } = req.body; // এখানে candidateId হলো মোবাইল নম্বর
  
  const mobileInfo = db.mobileSettings[candidateId];

  // ১. মোবাইল নম্বর রেজিস্টার্ড আছে কিনা চেক
  if (!mobileInfo) {
    return res.json({ success: false, message: "এই মোবাইল নম্বরটি সিস্টেমে নিবন্ধিত নয়।" });
  }

  // ২. নির্দিষ্ট পরীক্ষার জন্য কোড অনুমোদিত কিনা চেক
  const allowedCodes = mobileInfo.allowedExamCodes || [db.config.examCode];
  if (!allowedCodes.includes(examCode)) {
    return res.json({ success: false, message: "এই মোবাইল নম্বরের জন্য এই পরীক্ষা কোডটি অনুমোদিত নয়।" });
  }

  // ৩. ব্লক করা আছে কিনা চেক
  if (mobileInfo.isBlocked) {
    return res.json({ success: false, message: "এই মোবাইল নম্বরটি বর্তমানে ব্লক করা রয়েছে। অ্যাডমিনের সাথে যোগাযোগ করুন।" });
  }

  // ৪. মেয়াদ উত্তীর্ণ (Expiry Time) চেক
  if (mobileInfo.expiryTime) {
    const now = new Date();
    const expiry = new Date(mobileInfo.expiryTime);
    if (now > expiry) {
      return res.json({ success: false, message: "এই মোবাইল নম্বরের পরীক্ষার সময়সীমা পার হয়ে গেছে।" });
    }
  }

  // ৫. ইতিমধ্যে পরীক্ষা সম্পন্ন করেছে কিনা চেক
  const recordKey = `${examCode}_${candidateId}`;
  const isCompleted = db.completedMobiles && db.completedMobiles[recordKey];

  if (isCompleted) {
    const session = db.activeSessions[candidateId];
    if (!session) {
      return res.json({ success: false, message: "এই মোবাইল নম্বর দিয়ে ইতিমধ্যে পরীক্ষা সম্পন্ন হয়েছে।" });
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

// নির্ভুল টাইপিং মেট্রিকস (Gross WPM, Net WPM, Accuracy, Errors) ক্যালকুলেশন
function calculateMetrics(original, typed, durationMin, minPassWpm) {
  const cleanOriginal = (original || "").trim();
  const cleanTyped = (typed || "").trim();

  if (cleanTyped === "") {
    return {
      totalWords: 0,
      correctWords: 0,
      errors: 0,
      accuracy: 0,
      errorPercent: 100,
      grossWpm: 0,
      netWpm: 0,
      passed: false
    };
  }

  const origWords = cleanOriginal.split(/\s+/);
  const typedWords = cleanTyped.split(/\s+/).filter(w => w.length > 0);
  
  let correctWords = 0;
  let errors = 0;

  // শব্দ ধরে নিখুঁত তুলনা
  typedWords.forEach((word, index) => {
    if (origWords[index] === word) {
      correctWords++;
    } else {
      errors++;
    }
  });

  if (typedWords.length > origWords.length) {
    errors += (typedWords.length - origWords.length);
  }

  const totalTypedCount = typedWords.length;
  const totalCharsWithoutSpaces = cleanTyped.replace(/\s+/g, '').length;
  const standardWords = totalCharsWithoutSpaces / 5;

  const accuracy = totalTypedCount > 0 ? parseFloat(((correctWords / totalTypedCount) * 100).toFixed(1)) : 0;
  const errorPercent = totalTypedCount > 0 ? parseFloat(((errors / totalTypedCount) * 100).toFixed(1)) : 0;
  
  const grossWpm = durationMin > 0 ? Math.round(standardWords / durationMin) : 0;
  const netWpm = durationMin > 0 ? Math.max(0, Math.round((correctWords / durationMin))) : 0;
  
  const isPassed = errorPercent <= 10.0 && netWpm >= minPassWpm;

  return {
    totalWords: Math.round(standardWords),
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
  const { candidateId, candidateName, examCode, engText, bnText } = req.body;
  const currentExamCode = examCode || db.config.examCode;

  const engRes = calculateMetrics(db.config.engPassage, engText || '', db.config.duration, db.config.engMinPassWpm);
  const bnRes = calculateMetrics(db.config.bnPassage, bnText || '', db.config.duration, db.config.bnMinPassWpm);

  // সঠিক জমার তারিখ ও সময় (বাংলাদেশ ফরম্যাট)
  const now = new Date();
  const submissionTime = now.toLocaleString('bn-BD', { 
    timeZone: 'Asia/Dhaka', 
    year: 'numeric', 
    month: 'numeric', 
    day: 'numeric', 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit', 
    hour12: true 
  });

  const finalResult = {
    candidateId, // মোবাইল নম্বর
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
  
  if (!db.completedMobiles) db.completedMobiles = {};
  db.completedMobiles[`${currentExamCode}_${candidateId}`] = true;

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
    rollSettings: db.mobileSettings || {} // ফ্রন্টএন্ডের সুবিধার জন্য রোল সেটিংস প্রপার্টিতে মোবাইল সেটিংস পাঠানো হলো
  });
});

app.post('/api/admin/update-config', (req, res) => {
  const { 
    examCode, engPassage, bnPassage, duration, engMinPassWpm, bnMinPassWpm, 
    currPass, newPass, secQ, currSecAns, newSecAns, rollUpdates, newRolls 
  } = req.body;

  if (currPass && currPass.trim() !== "" && currPass !== db.config.adminPassword) {
    return res.json({ success: false, message: "বর্তমান পাসওয়ার্ড ভুল!" });
  }
  
  if (currSecAns && currSecAns.trim() !== "" && currSecAns !== db.config.securityAnswer) {
    return res.json({ success: false, message: "বর্তমান সিকিউরিটি উত্তর ভুল!" });
  }

  if (examCode) db.config.examCode = examCode;
  if (engPassage !== undefined) db.config.engPassage = engPassage;
  if (bnPassage !== undefined) db.config.bnPassage = bnPassage;
  if (duration) db.config.duration = parseInt(duration);
  if (engMinPassWpm) db.config.engMinPassWpm = parseInt(engMinPassWpm);
  if (bnMinPassWpm) db.config.bnMinPassWpm = parseInt(bnMinPassWpm);

  if (rollUpdates && Array.isArray(rollUpdates)) {
    rollUpdates.forEach(item => {
      const { roll, expiryTime, isBlocked, allowedExamCodes } = item; // এখানে roll মানে মোবাইল নম্বর
      if (roll) {
        if (!db.mobileSettings[roll]) {
          db.mobileSettings[roll] = { expiryTime: "", isBlocked: false, allowedExamCodes: [db.config.examCode] };
        }
        if (expiryTime !== undefined) db.mobileSettings[roll].expiryTime = expiryTime;
        if (isBlocked !== undefined) db.mobileSettings[roll].isBlocked = isBlocked;
        if (allowedExamCodes !== undefined) {
          db.mobileSettings[roll].allowedExamCodes = Array.isArray(allowedExamCodes) 
            ? allowedExamCodes 
            : allowedExamCodes.split(',').map(c => c.trim()).filter(c => c.length > 0);
        }
      }
    });
  }

  if (newRolls && newRolls.trim() !== "") {
    const list = newRolls.split(/[\n,]+/).map(r => r.trim()).filter(r => r.length > 0);
    list.forEach(r => {
      if (!db.mobileSettings[r]) {
        db.mobileSettings[r] = { expiryTime: "", isBlocked: false, allowedExamCodes: [db.config.examCode] };
      }
    });
  }

  if (newPass && newPass.trim() !== "") db.config.adminPassword = newPass.trim();
  if (secQ && secQ.trim() !== "") db.config.securityQuestion = secQ.trim();
  if (newSecAns && newSecAns.trim() !== "") db.config.securityAnswer = newSecAns.trim();

  saveData();
  res.json({ success: true, message: "সেটিংস ও মোবাইল নম্বর ম্যানেজমেন্ট সফলভাবে আপডেট হয়েছে!" });
});

app.post('/api/admin/delete-roll', (req, res) => {
  const { roll } = req.body;
  if (db.mobileSettings[roll]) {
    delete db.mobileSettings[roll];
    saveData();
    return res.json({ success: true, message: `মোবাইল নম্বর ${roll} মুছে ফেলা হয়েছে।` });
  }
  res.json({ success: false, message: "মোবাইল নম্বরটি পাওয়া যায়নি।" });
});

app.post('/api/admin/reset-session', (req, res) => {
  const { candidateId, examCode } = req.body;
  if(!candidateId) return res.json({ success: false, message: "মোবাইল নম্বর দিন।" });

  const targetExamCode = examCode || db.config.examCode;
  const recordKey = `${targetExamCode}_${candidateId}`;
  let cleared = false;

  if (db.activeSessions[candidateId]) {
    delete db.activeSessions[candidateId];
    cleared = true;
  }
  if (db.completedMobiles && db.completedMobiles[recordKey]) {
    delete db.completedMobiles[recordKey];
    cleared = true;
  }

  if (cleared) {
    saveData();
    res.json({ success: true, message: `মোবাইল নম্বর ${candidateId}-কে পুনরায় টাইপ করার অনুমতি দেওয়া হয়েছে।` });
  } else {
    res.json({ success: false, message: "এই নম্বরের কোনো সক্রিয় বা সম্পন্ন রেকর্ড পাওয়া যায়নি।" });
  }
});

app.get('/api/admin/security-question', (req, res) => res.json({ question: db.config.securityQuestion }));

app.post('/api/admin/recover-password', (req, res) => {
  const { answer, newPassword } = req.body;
  if (answer && answer.trim() === db.config.securityAnswer) {
    if (newPassword && newPassword.trim() !== "") {
      db.config.adminPassword = newPassword.trim();
      saveData();
      return res.json({ success: true, message: "পাসওয়ার্ড সফলভাবে রিকভার হয়েছে!" });
    } else {
      return res.json({ success: false, message: "নতুন পাসওয়ার্ড দিন।" });
    }
  } else {
    return res.json({ success: false, message: "ভুল সিকিউরিটি উত্তর!" });
  }
});

// রেজাল্ট ফিল্টার ও ফেচ করার রুট
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
  db.completedMobiles = {};
  saveData();
  res.json({ success: true });
});

app.get('/api/admin/active-sessions', (req, res) => {
  res.json(db.activeSessions);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
