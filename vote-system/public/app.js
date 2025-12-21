const socket = io();

// DOM Elements
const loginScreen = document.getElementById('login-screen');
const voteScreen = document.getElementById('vote-screen');
const pinInput = document.getElementById('pin-input');
const joinBtn = document.getElementById('join-btn');
const questionEl = document.getElementById('question-text');
const optionsContainer = document.getElementById('options-container');
const totalVotesEl = document.getElementById('total-votes');
const timerEl = document.getElementById('timer');
const statusTextEl = document.getElementById('status-text');
const toastEl = document.getElementById('toast');

let myVotes = [];
let currentSettings = {};
let lastStatus = 'waiting';
let isHost = document.body.id === 'host-page';

// 投影模式檢測
const urlParams = new URLSearchParams(window.location.search);
const isProjector = urlParams.get('mode') === 'projector';
if (isProjector) document.body.classList.add('projector-mode');

// 金句庫
const quotes = [
    "「人生不是選擇題，而是申論題。」",
    "「選擇本身就是一種放棄，但也是一種獲得。」",
    "「此刻的決定，將成為未來的回憶。」",
    "「慢慢來，比較快。」",
    "「所有偉大的事物，都由微小的選擇開始。」",
    "「聽從你內心的聲音。」"
];
function getRandomQuote() { return quotes[Math.floor(Math.random() * quotes.length)]; }

// --- 1. 登入邏輯 ---
joinBtn.addEventListener('click', () => {
    const pin = pinInput.value;
    if (pin.length !== 4) return showToast('請輸入 4 位數 PIN');
    socket.emit('join', pin);
});

socket.on('joined', (data) => {
    if (data.success) {
        loginScreen.classList.add('hidden');
        voteScreen.classList.remove('hidden');
        // 注意：這裡移除了 initHostLogic 的呼叫，避免無窮迴圈
    } else {
        showToast(data.error);
    }
});

// --- 2. 狀態渲染 ---
socket.on('state-update', (state) => {
    renderMeeting(state);
});

socket.on('vote-confirmed', (votes) => {
    myVotes = votes;
    showToast('投票已記錄');
});

socket.on('timer-tick', (timeLeft) => {
    timerEl.textContent = timeLeft + 's';
    timerEl.style.color = timeLeft <= 10 ? 'var(--danger)' : 'inherit';
});

function renderMeeting(state) {
    currentSettings = state.settings;
    totalVotesEl.textContent = state.totalVotes;
    timerEl.textContent = state.timeLeft + 's';

    if (lastStatus === 'voting' && state.status === 'ended') launchConfetti();
    lastStatus = state.status;

    if (state.status === 'waiting') {
        statusTextEl.textContent = '準備中';
        optionsContainer.innerHTML = `
            <div style="text-align:center; padding:60px 20px; color:var(--text-light);">
                <div style="font-family:'Noto Serif TC'; font-size:1.5rem; margin-bottom:15px; color:var(--primary);">☕</div>
                <p style="font-family:'Noto Serif TC'; font-size:1.2rem; margin-bottom:10px; font-style:italic;">${getRandomQuote()}</p>
                <p style="font-size:0.9rem; opacity:0.7;">等待主持人開啟下一題...</p>
            </div>`;
        questionEl.textContent = '';
        return;
    }
    
    questionEl.textContent = state.question;

    if (state.status === 'voting') {
        statusTextEl.textContent = currentSettings.blindMode ? '投票進行中 (🙈 盲測)' : '投票進行中';
        statusTextEl.style.color = currentSettings.blindMode ? '#d97706' : 'var(--success)';
    } else {
        statusTextEl.textContent = '投票結束 (已鎖定)';
        statusTextEl.style.color = 'var(--danger)';
    }

    let html = '';
    state.options.forEach(opt => {
        const isSelected = myVotes.includes(opt.id);
        const isBlind = opt.percent === -1;
        
        const displayWidth = isBlind ? 0 : opt.percent;
        const displayText = isBlind ? '???' : `${opt.percent}% (${opt.count}票)`;
        const bgOpacity = isBlind ? 0 : 0.15;
        
        const stampHtml = isSelected ? `<div class="stamp-mark">已選</div>` : '';

        html += `
        <div class="option-card ${isSelected ? 'selected' : ''}" 
             onclick="handleVote(${opt.id})" 
             style="border-left: 5px solid ${opt.color}">
            ${stampHtml}
            <div class="progress-bg" style="width: ${displayWidth}%; background-color: ${opt.color}; opacity: ${bgOpacity};"></div>
            <div class="option-content">
                <span class="option-text">${opt.text}</span>
                <span class="vote-stats" style="${isBlind ? 'color:#cbd5e1' : ''}">${displayText}</span>
            </div>
        </div>`;
    });
    
    optionsContainer.innerHTML = html;
    
    if (state.status === 'ended') {
        Array.from(optionsContainer.children).forEach(child => child.style.pointerEvents = 'none');
    }
}

function handleVote(optionId) {
    if (statusTextEl.textContent.includes('結束')) return;
    if (navigator.vibrate) navigator.vibrate(15);

    if (currentSettings.allowMulti) {
        if (myVotes.includes(optionId)) myVotes = myVotes.filter(id => id !== optionId);
        else myVotes.push(optionId);
    } else {
        myVotes = [optionId];
    }
    socket.emit('submit-vote', myVotes);
}

function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    setTimeout(() => toastEl.style.opacity = '0', 2000);
}

function launchConfetti() {
    confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
}

// --- 3. 主持人邏輯 ---
function initHostLogic() {
    // 立即發送登入請求以獲取 PIN
    socket.emit('host-login');
    
    socket.on('host-data', (data) => {
        // 更新 PIN 顯示
        document.getElementById('host-pin-display').textContent = data.pin;
        // 自動加入會議室，這樣主持人也能收到倒數計時和預覽更新
        socket.emit('join', data.pin);
    });

    document.getElementById('start-vote-btn').addEventListener('click', () => {
        const question = document.getElementById('h-question').value;
        if(!question) return showToast('請輸入題目');

        const optInputs = document.querySelectorAll('.opt-text');
        const options = [];
        const colors = ['#84a98c', '#6b705c', '#d66853', '#ddbea9', '#3f4238', '#8e8d8a'];
        
        optInputs.forEach((input, idx) => {
            if(input.value.trim()) options.push({ text: input.value, color: colors[idx % colors.length] });
        });
        if(options.length < 2) return showToast('至少需要兩個選項');

        socket.emit('start-vote', {
            question, options,
            duration: parseInt(document.getElementById('h-timer').value) || 0,
            allowMulti: document.getElementById('h-multi').checked,
            blindMode: document.getElementById('h-blind').checked
        });
        showToast('投票已開始');
    });

    document.getElementById('stop-vote-btn').addEventListener('click', () => {
        socket.emit('stop-vote');
        showToast('已強制結束');
    });

    document.getElementById('clear-form-btn').addEventListener('click', () => {
        document.getElementById('h-question').value = '';
        document.querySelectorAll('.opt-text').forEach((input, i) => input.value = i<2 ? (i===0?'同意':'不同意') : '');
        showToast('表格已重置');
    });

    document.getElementById('export-btn').addEventListener('click', () => {
        socket.emit('request-export');
        showToast('正在準備檔案...');
    });
    
    document.getElementById('open-projector-btn').addEventListener('click', () => {
        const url = window.location.href.replace('host.html', 'index.html') + '?mode=projector';
        window.open(url, 'ProjectorWindow', 'width=1024,height=768');
    });
}

socket.on('export-data', (csvContent) => {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `投票結果_${new Date().toISOString().slice(0,19).replace(/:/g,"-")}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
});

window.applyPreset = function(type) {
    const qInput = document.getElementById('h-question');
    const optInputs = document.querySelectorAll('.opt-text');
    qInput.value = ''; optInputs.forEach(i => i.value = '');

    if (type === 'yesno') {
        qInput.value = '您是否同意此提案？';
        optInputs[0].value = '⭕ 同意'; optInputs[1].value = '❌ 不同意';
    } else if (type === 'scale') {
        qInput.value = '請對本次活動進行評分';
        optInputs[0].value = '⭐️⭐️⭐️⭐️⭐️ 非常滿意'; optInputs[1].value = '⭐️⭐️⭐️⭐️ 滿意';
        optInputs[2].value = '⭐️⭐️⭐️ 普通'; optInputs[3].value = '⭐️⭐️ 尚可'; optInputs[4].value = '⭐️ 待加強';
    } else if (type === 'lunch') {
        qInput.value = '今天午餐想吃什麼類別？';
        optInputs[0].value = '🍱 便當/自助餐'; optInputs[1].value = '🍜 麵食/水餃';
        optInputs[2].value = '🍔 速食'; optInputs[3].value = '🥗 輕食/沙拉';
    }
    showToast('已套用樣板');
};

// --- 關鍵修正：如果是主持人頁面，立即啟動邏輯 ---
if (isHost && !isProjector) {
    initHostLogic();
}
