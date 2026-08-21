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
        
        if (!db.config) db.config = {};
        db.config.adminPassword = "632750";
        if (!db.config.securityQuestion) db.config.securityQuestion = "আপনার প্রিয় রঙ কোনটি?";
        if (!db.config.securityAnswer) db.config.securityAnswer = "blue";
        
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

// পরীক্ষার্থী ভ্যালিডেশন
app.post('/api/validate-candidate', (req, res) => {
  const { candidateId, examCode } = req.body; 
  const mobileInfo = db.mobileSettings[candidateId];

  if (!mobileInfo) {
    return res.json({ success: false, message: "এই মোবাইল নম্বরটি সিস্টেমে নিবন্ধিত নয়।" });
  }

  const allowedCodes = mobileInfo.allowedExamCodes || [db.config.examCode];
  if (!allowedCodes.includes(examCode)) {
    return res.json({ success: false, message: "এই মোবাইল নম্বরের জন্য এই পরীক্ষা কোডটি অনুমোদিত নয়।" });
  }

  if (mobileInfo.isBlocked) {
    return res.json({ success: false, message: "এই মোবাইল নম্বরটি বর্তমানে ব্লক করা রয়েছে। অ্যাডমিনের সাথে যোগাযোগ করুন।" });
  }

  if (mobileInfo.expiryTime) {
    const now = new Date();
    const expiry = new Date(mobileInfo.expiryTime);
    if (now > expiry) {
      return res.json({ success: false, message: "এই মোবাইল নম্বরের পরীক্ষার সময়সীমা পার হয়ে গেছে।" });
    }
  }

  const recordKey = `${examCode}_${candidateId}`;
  const isCompleted = db.completedMobiles && db.completedMobiles[recordKey];

  if (isCompleted) {
    const session = db.activeSessions[candidateId];
    if (!session) {
      return res.json({ success: false, message: "এই মোবাইল নম্বর দিয়ে ইতিমধ্যে পরীক্ষা সম্পন্ন হয়েছে।" });
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

/**
 * মাইক্রোসফট ওয়ার্ডের 'Characters (no spaces)' নিয়মে হুবহু মেলানোর জন্য ক্যালকুলেশন
 * (স্পেস বাদে বিরামচিহ্ন সহ সব ক্যারেক্টার গোনা হবে)
 */
function calculateMetrics(original, typed, durationMin, minPassWpm, isBangla = false) {
  const origText = original || "";
  const typeText = typed || "";

  if (typeText.trim() === "") {
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

  // স্পেস দিয়ে শব্দগুলোকে আলাদা করা হচ্ছে (এমএস ওয়ার্ড এভাবেই কাজ করে)
  let origWords = origText.trim().split(/\s+/);
  let typedWords = typeText.trim().split(/\s+/);

  let totalTypedChars = 0;
  let correctChars = 0;
  let errors = 0;

  const maxWords = Math.max(origWords.length, typedWords.length);

  for (let w = 0; w < maxWords; w++) {
    const oWord = origWords[w] || "";
    const tWord = typedWords[w] || "";

    // Array.from() ব্যবহার করা হয়েছে যা বাংলা ও ইংরেজির প্রতিটি ক্যারেক্টার এবং বিরামচিহ্ন হুবহু আলাদা করবে
    let oChars = Array.from(oWord);
    let tChars = Array.from(tWord);

    totalTypedChars += tChars.length;

    let mismatchFound = false;
    const maxLength = Math.max(oChars.length, tChars.length);

    for (let i = 0; i < maxLength; i++) {
      const oChar = oChars[i];
      const tChar = tChars[i];

      if (mismatchFound) {
        errors++;
      } else {
        if (tChar === undefined || oChar === undefined || oChar !== tChar) {
          mismatchFound = true;
          errors++;
        } else {
          correctChars++;
        }
      }
    }
  }

  // স্পেসগুলোকে হিসাবের বাইরে রাখা হয়েছে (মাইক্রোসফট ওয়ার্ডের no spaces নিয়মের সাথে মেলানোর জন্য)
  const standardWords = totalTypedChars / 5; 
  const accuracy = totalTypedChars > 0 ? parseFloat(((correctChars / totalTypedChars) * 100).toFixed(1)) : 0;
  const errorPercent = totalTypedChars > 0 ? parseFloat(((errors / totalTypedChars) * 100).toFixed(1)) : 100;
  
  const grossWpm = durationMin > 0 ? Math.round(standardWords / durationMin) : 0;
  const standardCorrectWords = correctChars / 5;
  const netWpm = durationMin > 0 ? Math.max(0, Math.round(standardCorrectWords / durationMin)) : 0;
  
  const isPassed = errorPercent < 5.0 && netWpm >= minPassWpm;

  return {
    totalWords: Math.round(standardWords),
    correctWords: Math.round(standardCorrectWords),
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

  const engRes = calculateMetrics(db.config.engPassage, engText || '', db.config.duration, db.config.engMinPassWpm, false);
  const bnRes = calculateMetrics(db.config.bnPassage, bnText || '', db.config.duration, db.config.bnMinPassWpm, true);

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
    rollSettings: db.mobileSettings || {} 
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
      const { roll, expiryTime, isBlocked, allowedExamCodes } = item; 
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

app.post('/api/admin/delete-result', (req, res) => {
  const { candidateId, examCode } = req.body;
  const initialLength = db.results.length;
  db.results = db.results.filter(r => !(r.candidateId === candidateId && r.examCode === examCode));

  if (db.results.length < initialLength) {
    const recordKey = `${examCode}_${candidateId}`;
    if (db.completedMobiles && db.completedMobiles[recordKey]) {
      delete db.completedMobiles[recordKey];
    }
    saveData();
    return res.json({ success: true, message: "পরীক্ষার্থীর ফলাফল সফলভাবে মুছে ফেলা হয়েছে।" });
  } else {
    return res.json({ success: false, message: "ফলাফলটি পাওয়া যায়নি।" });
  }
});

app.post('/api/admin/reset-all-results', (req, res) => {
  const { password } = req.body;

  if (password !== db.config.adminPassword) {
    return res.json({ success: false, message: "ভুল এডমিন পাসওয়ার্ড!" });
  }

  db.results = [];
  db.completedMobiles = {};
  db.activeSessions = {};
  saveData();
  
  res.json({ success: true, message: "সমস্ত পরীক্ষার্থীর ফলাফল এবং ডাটা সফলভাবে মুছে ফেলা হয়েছে!" });
});

app.delete('/api/results/:index', (req, res, next) => {
  const idx = parseInt(req.params.index);
  if (idx >= 0 && idx < db.results.length) {
    db.results.splice(idx, 1);
    saveData();
  }
  res.json({ success: true });
});

app.delete('/api/results', (req, res, next) => {
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
