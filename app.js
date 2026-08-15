let candidateData = { candidateId: '', candidateName: '' };
let examConfig = {};
let engTimerInterval = null;
let bnTimerInterval = null;
let engTimeLeft = 0;
let bnTimeLeft = 0;

// ট্যাব সুইচ অ্যান্টি-চিটিং ওয়ার্নিং
document.addEventListener("visibilitychange", function() {
    if (document.hidden) {
        if (!document.getElementById('eng-card').classList.contains('hidden') || 
            !document.getElementById('bn-card').classList.contains('hidden')) {
            alert("সতর্কবার্তা: পরীক্ষা চলাকালীন অন্য ট্যাব বা উইন্ডোতে যাওয়া নিষিদ্ধ!");
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

    candidateData = { candidateId, candidateName };

    // যদি আগের কোনো সংরক্ষিত সেশন পাওয়া যায় (Server Resume)
    if (valData.hasSavedSession && valData.sessionData) {
        if (confirm("আপনার পূর্বের অসমাপ্ত পরীক্ষা সার্ভারে পাওয়া গেছে। আপনি কি সেখান থেকেই শুরু করতে চান?")) {
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
        startEnglishStep(session.engTimeLeft || (examConfig.engDuration * 60), session.engText || '');
    } else if (session.step === 'bn') {
        document.getElementById('eng-typing-area').value = session.engText || '';
        startBanglaStep(session.bnTimeLeft || (examConfig.bnDuration * 60), session.bnText || '');
    }
}

function autoSaveProgress(step) {
    const engText = document.getElementById('eng-typing-area').value;
    const bnText = document.getElementById('bn-typing-area').value;

    fetch('/api/save-progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            candidateId: candidateData.candidateId,
            candidateName: candidateData.candidateName,
            step,
            engText,
            bnText,
            engTimeLeft,
            bnTimeLeft
        })
    });
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

    engTimeLeft = savedTime !== undefined ? savedTime : examConfig.engDuration * 60;

    engTimerInterval = setInterval(() => {
        engTimeLeft--;
        const m = Math.floor(engTimeLeft / 60).toString().padStart(2, '0');
        const s = (engTimeLeft % 60).toString().padStart(2, '0');
        document.getElementById('eng-timer').innerText = `${m}:${s}`;

        if (engTimeLeft % 5 === 0) autoSaveProgress('eng'); // প্রতি ৫ সেকেন্ডে অটোসেভ

        if (engTimeLeft <= 0) {
            clearInterval(engTimerInterval);
            alert("ইংরেজি টাইপিংয়ের সময় শেষ!");
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

    bnTimeLeft = savedTime !== undefined ? savedTime : examConfig.bnDuration * 60;

    bnTimerInterval = setInterval(() => {
        bnTimeLeft--;
        const m = Math.floor(bnTimeLeft / 60).toString().padStart(2, '0');
        const s = (bnTimeLeft % 60).toString().padStart(2, '0');
        document.getElementById('bn-timer').innerText = `${m}:${s}`;

        if (bnTimeLeft % 5 === 0) autoSaveProgress('bn');

        if (bnTimeLeft <= 0) {
            clearInterval(bnTimerInterval);
            alert("বাংলা টাইপিংয়ের সময় শেষ!");
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
            engText,
            bnText
        })
    });

    const data = await res.json();
    if (data.success) {
        document.getElementById('bn-card').classList.add('hidden');
        document.getElementById('success-card').classList.remove('hidden');
    }
}