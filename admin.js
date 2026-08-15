const socket = io();

// প্রথমবার পেজ লোড হলে সংরক্ষিত রেজাল্ট আনবে
window.onload = async () => {
  loadCompletedResults();
};

async function loadCompletedResults() {
  try {
    const response = await fetch('/api/results');
    const results = await response.json();
    renderTable(results);
  } catch (err) {
    console.error("ডাটা লোড করতে সমস্যা হয়েছে:", err);
  }
}

function renderTable(results) {
  const tbody = document.getElementById("results-body");
  if (!results || results.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;">কোনো পরীক্ষা এখনও শেষ হয়নি</td></tr>`;
    return;
  }

  tbody.innerHTML = results.map(res => `
    <tr>
      <td><strong>${res.candidateId}</strong></td>
      <td>${res.candidateName}</td>
      <td><b style="color: #16a34a;">${res.netWpm}</b></td>
      <td>${res.grossWpm}</td>
      <td>${res.accuracy}%</td>
      <td>${res.timeTakenSeconds}s</td>
      <td>${new Date(res.submittedAt).toLocaleTimeString()}</td>
    </tr>
  `).join("");
}

// Socket.io রিয়েল টাইম আপডেট
socket.on('exam_submitted', (data) => {
  loadCompletedResults();
});