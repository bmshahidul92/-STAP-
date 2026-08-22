const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data.json');

let db = {
  config: {
    examCode: "ECS2026",
    engPassage: "The quick brown fox jumps over the lazy dog. Fast typing requires practice and precision.",
    bnPassage: "আমাদের বাংলাদেশের প্রাকৃতিক সৌন্দর্য অপরূপ। বাংলা ভাষায় সঠিক ও দ্রুত টাইপিং জানা অত্যন্ত প্রয়োজনীয়।",
    duration: 1,
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
        
        if (!db.mobileSettings) db.mobileSettings = db.rollSettings || {};
        if (!db.completedMobiles) db.completedMobiles = db.completedRolls || {};
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

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
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
    return res.json({ success: false, message: "এই মোবাইল নম্বরটি বর্তমানে ব্লক করা রয়েছে।" });
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

/**
 * মাইক্রোসফট ওয়ার্ডের স্টাইলে স্ট্রোক বা ক্যারেক্টার এবং ভুল গণনার নিখুঁত লজিক (বাংলা ও ইংরেজি উভয় ক্ষেত্রে সমান)
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

 // ১. স্পেস বাদ দিয়ে শুধু লেখা বা ক্যারেক্টারগুলো নেওয়া
const origClean = origText.replace(/\s+/g, '');
const typedClean = typeText.replace(/\s+/g, '');

const totalTypedChars = typedClean.length;         // স্পেস ছাড়া মোট টাইপকৃত ক্যারেক্টার
const totalOriginalChars = origClean.length;     // স্পেস ছাড়া প্রশ্নের মোট ক্যারেক্টার

let correctChars = 0;
let errors = 0;

// ২. শব্দভিত্তিক তুলনা লজিক
const origWords = origText.trim().split(/\s+/);
const typedWords = typeText.trim().split(/\s+/);

for (let i = 0; i < origWords.length; i++) {
    if (typedWords[i] === origWords[i]) {
        // শব্দ সঠিক হলে স্পেস বাদ দিয়ে ওই শব্দের ক্যারেক্টারগুলো যোগ হবে
        correctChars += origWords[i] ? origWords[i].replace(/\s+/g, '').length : 0;
    } else {
        // শব্দ ভুল হলে মূল শব্দের ক্যারেক্টারগুলো ভুল হিসেবে যোগ হবে
        errors += origWords[i] ? origWords[i].replace(/\s+/g, '').length : 0;
    }
}

// ৩. অতিরিক্ত টাইপ করলে তাও ভুল ধরবে
if (typedWords.length > origWords.length) {
    for (let j = origWords.length; j < typedWords.length; j++) {
        errors += typedWords[j] ? typedWords[j].replace(/\s+/g, '').length : 0;
    }
}

// ৪. সেফটি চেক
if (correctChars > totalTypedChars) {
    correctChars = totalTypedChars;
} 
  
  // স্ট্যান্ডার্ড ওয়ার্ড ক্যালকুলেশন (৫ ক্যারেক্টারে ১ শব্দ)
  const standardWords = totalTypedChars / 5; 
  const accuracy = totalTypedChars > 0 ? parseFloat(((correctChars / totalTypedChars) * 100).toFixed(1)) : 0;
  const errorPercent = totalTypedChars > 0 ? parseFloat(((errors / totalTypedChars) * 100).toFixed(1)) : 100;
  
  const grossWpm = durationMin > 0 ? Math.round(standardWords / durationMin) : 0;
  const standardCorrectWords = correctChars / 5;
  const netWpm = durationMin > 0 ? Math.max(0, Math.round(standardCorrectWords / durationMin)) : 0;
  
  const isPassed = errorPercent < 5.0 && netWpm >= minPassWpm;

  return {
    totalWords: totalTypedChars,      // মোট স্ট্রোক
    correctWords: correctChars,      // সঠিক স্ট্রোক
    errors: errors,                  // ভুল স্ট্রোক
    accuracy: accuracy,              // সঠিকতার হার (%)
    errorPercent: errorPercent,      // ভুলের হার (%)
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
    year: 'numeric', month: 'numeric', day: 'numeric', 
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true 
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
  if (engPassage !== undefined) db.config.examPassage = engPassage;
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
  res.json({ success: true, message: "সেটিংস সফলভাবে আপডেট হয়েছে!" });
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
    res.json({ success: true, message: `মোবাইল নম্বর ${candidateId}-কে পুনরায় পরীক্ষার অনুমতি দেওয়া হয়েছে।` });
  } else {
    res.json({ success: false, message: "কোনো সক্রিয় রেকর্ড পাওয়া যায়নি।" });
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

app.post('/api/admin/reset-all-results', (req, res) => {
  const { password } = req.body;
  if (password !== db.config.adminPassword) {
    return res.json({ success: false, message: "ভুল এডমিন পাসওয়ার্ড!" });
  }
  db.results = [];
  db.completedMobiles = {};
  db.activeSessions = {};
  saveData();
  res.json({ success: true, message: "সমস্ত ফলাফল সফলভাবে মুছে ফেলা হয়েছে!" });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
