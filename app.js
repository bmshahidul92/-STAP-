let candidateData = { candidateId: '', candidateName: '', examCode: '' };
let examConfig = {};
let engTimerInterval = null;
let bnTimerInterval = null;
let engTimeLeft = 0;
let bnTimeLeft = 0;

// Socket.io কানেকশন ইনিশিয়ালাইজেশন
const socket = io();

// ট্যাব সুইচ অ্যান্টি-চিটিং ওয়ার্নিং
document.addEventListener("visibilitychange", function() {
    if (document.hidden) {
        if (!document.getElementById('eng-card').classList.contains('hidden') || 
            !document.getElementById('bn-card').classList.contains('hidden')) {
            alert("সতর্কবার্তা: পরীক্ষা চলাকালীন অন্য ট্যাব বা উইন্ডোতে যাওয়া নিষিদ্ধ!");
        }
    }
});

async function handleLogin() {
    const candidateId = document.getElementById('candidate-id').value.trim();
    const candidateName = document.getElementById('candidate-name').value.trim();
    const examCode = document.getElementById('exam-code').value.trim();

    if(!candidateId || !candidateName || !examCode) return alert("সকল তথ্য পূরণ করুন!");

    // কনফিগারেশন লোড
    const cfgRes = await fetch('/api/exam-config');
    examConfig = await cfgRes.json();

    // ভ্যালিডেশন চেক
    const valRes = await fetch('/api/validate-candidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId, examCode })
    });
    const valData = await valRes.json();

    if (!valData.success) {
        return alert(valData.message);
    }

    candidateData = { candidateId, candidateName, examCode };

    // যদি আগের কোনো সংরক্ষিত সেশন পাওয়া যায় (Server Resume)
    if (valData.hasSavedSession && valData.sessionData) {
        if (confirm("আপনার পূর্বের অসমাপ্ত পরীক্ষা সার্ভারে পাওয়া গেছে। আপনি কি সেখান থেকেই শুরু করতে চান?")) {
            restoreSavedSession(valData.sessionData);
            return;
        }
    }

    document.getElementById('login-card').classList.add('hidden');
    document.getElementById('instruction-card').classList.remove('hidden');
}

function restoreSavedSession(session) {
    document.getElementById('login-card').classList.add('hidden');
    if (session.step === 'eng') {
        startEnglishStep(session.engTimeLeft || (examConfig.duration * 60), session.engText || '');
    } else if (session.step === 'bn') {
        document.getElementById('eng-typing-area').value = session.engText || '';
        startBanglaStep(session.bnTimeLeft || (examConfig.duration * 60), session.bnText || '');
    }
}

function autoSaveProgress(step, text, wpm, accuracy) {
    fetch('/api/save-progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            candidateId: candidateData.candidateId,
            candidateName: candidateData.candidateName,
            examCode: candidateData.examCode,
            step,
            engText: step === 'eng' ? text : document.getElementById('eng-typing-area').value,
            bnText: step === 'bn' ? text : document.getElementById('bn-typing-area').value,
            engTimeLeft,
            bnTimeLeft
        })
    });

    // লাইভ লিডারবোর্ডের জন্য Socket ডেটা পাঠানো
    socket.emit('live_progress', {
        candidateId: candidateData.candidateId,
        candidateName: candidateData.candidateName,
        step,
        currentWpm: wpm || 0,
        currentAccuracy: accuracy || 100
    });
}

// রিয়েল-টাইম স্ট্যাটস ক্যালকুলেটর (WPM ও Accuracy বের করার জন্য)
function calculateLiveStats(typedText, originalText, timeElapsedMinutes) {
    if (timeElapsedMinutes <= 0 || !typedText) return { wpm: 0, accuracy: 100 };
    
    const typedWords = typedText.trim().split(/\s+/).filter(Boolean);
    const totalWords = typedWords.length;
    const grossWpm = Math.round(totalWords / timeElapsedMinutes);

    // সহজ সঠিকতা যাচাই
    let correctChars = 0;
    for (let i = 0; i < typedText.length; i++) {
        if (originalText[i] === typedText[i]) correctChars++;
    }
    const accuracy = typedText.length > 0 ? Math.round((correctChars / typedText.length) * 100) : 100;
    
    return { wpm: grossWpm, accuracy: Math.max(0, accuracy) };
}

function startEnglishStep(savedTime, savedText) {
    document.getElementById('instruction-card').classList.add('hidden');
    document.getElementById('eng-card').classList.remove('hidden');

    document.getElementById('eng-disp-name').innerText = candidateData.candidateName;
    document.getElementById('eng-disp-id').innerText = candidateData.candidateId;
    document.getElementById('eng-passage').innerText = examConfig.engPassage;

    const textarea = document.getElementById('eng-typing-area');
    if (savedText) textarea.value = savedText;
    textarea.focus();

    const totalDurationSec = examConfig.duration * 60;
    engTimeLeft = savedTime !== undefined ? savedTime : totalDurationSec;

    textarea.addEventListener('input', () => {
        const elapsedTimeMin = (totalDurationSec - engTimeLeft) / 60 || 0.1;
        const stats = calculateLiveStats(textarea.value, examConfig.engPassage, elapsedTimeMin);
        autoSaveProgress('eng', textarea.value, stats.wpm, stats.accuracy);
    });

    engTimerInterval = setInterval(() => {
        engTimeLeft--;
        const m = Math.floor(engTimeLeft / 60).toString().padStart(2, '0');
        const s = (engTimeLeft % 60).toString().padStart(2, '0');
        document.getElementById('eng-timer').innerText = `${m}:${s}`;

        if (engTimeLeft <= 0) {
            clearInterval(engTimerInterval);
            alert("ইংরেজি টাইপিংয়ের সময় শেষ!");
            finishEnglishStep();
        }
    }, 1000);
}

function finishEnglishStep() {
    clearInterval(engTimerInterval);
    document.getElementById('eng-card').classList.add('hidden');
    startBanglaStep();
}

function startBanglaStep(savedTime, savedText) {
    document.getElementById('bn-card').classList.remove('hidden');

    document.getElementById('bn-disp-name').innerText = candidateData.candidateName;
    document.getElementById('bn-disp-id').innerText = candidateData.candidateId;
    document.getElementById('bn-passage').innerText = examConfig.bnPassage;

    const textarea = document.getElementById('bn-typing-area');
    if (savedText) textarea.value = savedText;
    textarea.focus();

    const totalDurationSec = examConfig.duration * 60;
    bnTimeLeft = savedTime !== undefined ? savedTime : totalDurationSec;

    textarea.addEventListener('input', () => {
        const elapsedTimeMin = (totalDurationSec - bnTimeLeft) / 60 || 0.1;
        const stats = calculateLiveStats(textarea.value, examConfig.bnPassage, elapsedTimeMin);
        autoSaveProgress('bn', textarea.value, stats.wpm, stats.accuracy);
    });

    bnTimerInterval = setInterval(() => {
        bnTimeLeft--;
        const m = Math.floor(bnTimeLeft / 60).toString().padStart(2, '0');
        const s = (bnTimeLeft % 60).toString().padStart(2, '0');
        document.getElementById('bn-timer').innerText = `${m}:${s}`;

        if (bnTimeLeft <= 0) {
            clearInterval(bnTimerInterval);
            alert("বাংলা টাইপিংয়ের সময় শেষ!");
            submitFinalExam();
        }
    }, 1000);
}

async function submitFinalExam() {
    clearInterval(bnTimerInterval);

    const engText = document.getElementById('eng-typing-area').value;
    const bnText = document.getElementById('bn-typing-area').value;

    const res = await fetch('/api/submit-exam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            candidateId: candidateData.candidateId,
            candidateName: candidateData.candidateName,
            examCode: candidateData.examCode,
            engText,
            bnText
        })
    });

    const data = await res.json();
    if (data.success) {
        document.getElementById('bn-card').classList.add('hidden');
        document.getElementById('success-card').classList.remove('hidden');
    } else {
        alert(data.message || "জমা দিতে সমস্যা হয়েছে। আবার চেষ্টা করুন।");
    }
}
