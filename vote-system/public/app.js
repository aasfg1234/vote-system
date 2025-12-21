const socket = io();

// DOM Elements
const loginScreen = document.getElementById('login-screen');
const voteScreen = document.getElementById('vote-screen');
const pinInput = document.getElementById('pin-input');
const usernameInput = document.getElementById('username-input'); // 新增
const joinBtn = document.getElementById('join-btn');
const questionEl = document.getElementById('question-text');
const optionsContainer = document.getElementById('options-container');
const totalVotesEl = document.getElementById('total-votes');
const joinedCountEl = document.getElementById('joined-count'); 
const timerEl = document.getElementById('timer');
const statusTextEl = document.getElementById('status-text');
const toastEl = document.getElementById('toast');

let myVotes = [];
let currentSettings = {};
let lastStatus = 'waiting';
let currentVoteId = 0; 
let currentPin = '';
let currentUsername = localStorage.getItem('vote_username') || ''; // 從本地讀取名字

const isHostPage = document.body.id === 'host-page';
const isParticipantPage = document.body.id === 'participant-page';

const urlParams = new URLSearchParams(window.location.search);
const isProjector = urlParams.get('mode') === 'projector';
if (isProjector) document.body.classList.add('projector-mode');

// 初始化：如果之前輸入過名字，自動填入
if (usernameInput && currentUsername) {
    usernameInput.value = currentUsername;
}

// 斷線重連邏輯
socket.on('connect', () => {
    if (currentPin && currentUsername) {
        socket.emit('join', { pin: currentPin, username: currentUsername });
        console.log('Reconnecting...');
    }
});

const quotes = [
    "「人生不是選擇題，而是申論題。」",
    "「選擇本身就是一種放棄，但也是一種獲得。」",
    "「此刻的決定，將成為未來的回憶。」",
    "「慢慢來，比較快。」",
    "「所有偉大的事物，都由微小的選擇開始。」",
    "「聽從你內心的聲音。」"
];
function getRandomQuote() { return quotes[Math.floor(Math.random() * quotes.length)]; }

// --- 1. 與會者邏輯 ---
if (isParticipantPage) {
    if (joinBtn) {
        joinBtn.addEventListener('click', () => {
            const pin = pinInput.value;
            const username = usernameInput.value.trim();

            if (!username) return showToast('請輸入姓名');
            if (pin.length !== 4) return showToast('請輸入 4 位數 PIN');
            
            // 儲存資訊
            currentPin = pin;
            currentUsername = username;
            localStorage.setItem('vote_username', username); // 記住名字

            socket.emit('join', { pin: pin, username: username });
        });
    }

    socket.on('joined', (data) => {
        if (data.success) {
            loginScreen.classList.add('hidden');
            voteScreen.classList.remove('hidden');
        } else {
            showToast(data.error);
            currentPin = ''; 
        }
    });
}

// --- 2. 狀態渲染 ---
socket.on('state-update', (state) => {
    if (!voteScreen && !isHostPage) return; 
    renderMeeting(state);
});

socket.on('vote-confirmed', (votes) => {
    myVotes = votes;
    updateSelectionUI();
    showToast('投票已記錄');
});

socket.on('timer-tick', (timeLeft) => {
    if(timerEl) {
        timerEl.textContent = timeLeft + 's';
        timerEl.style.color = timeLeft <= 10 ? 'var(--danger)' : 'inherit';
    }
});

function renderMeeting(state) {
    if (state.voteId !== currentVoteId) {
        myVotes = [];
        currentVoteId = state.voteId;
        updateSelectionUI(); 
    }

    currentSettings = state.settings;
    if(totalVotesEl) totalVotesEl.textContent = state.totalVotes;
    if(joinedCountEl) joinedCountEl.textContent = state.joinedCount;
    if(timerEl) timerEl.textContent = state.timeLeft + 's';

    if (lastStatus === 'voting' && state.status === 'ended') launchConfetti();
    lastStatus = state.status;

    if (state.status === 'waiting') {
        myVotes = [];
        if(statusTextEl) statusTextEl.textContent = '準備中';
        if(optionsContainer) optionsContainer.innerHTML = `
            <div style="text-align:center; padding:60px 20px; color:var(--text-light);">
                <div style="font-family:'Noto Serif TC'; font-size:1.5rem; margin-bottom:15px; color:var(--primary);">☕</div>
                <p style="font-family:'Noto Serif TC'; font-size:1.2rem; margin-bottom:10px; font-style:italic;">${getRandomQuote()}</p>
                <p style="font-size:0.9rem; opacity:0.7;">等待主持人開啟下一題...</p>
            </div>`;
        if(questionEl) questionEl.textContent = '';
        return;
    }
    
    if(questionEl) questionEl.textContent = state.question;

    if(statusTextEl) {
        if (state.status === 'voting') {
            statusTextEl.textContent = currentSettings.blindMode ? '投票進行中 (🙈 盲測)' : '投票進行中';
            statusTextEl.style.color = currentSettings.blindMode ? '#d97706' : 'var(--success)';
        } else {
            statusTextEl.textContent = '投票結束 (已鎖定)';
            statusTextEl.style.color = 'var(--danger)';
        }
    }

    let html = '';
    state.options.forEach(opt => {
        const isBlind = opt.percent === -1;
        const displayWidth = isBlind ? 0 : opt.percent;
        const displayText = isBlind ? '???' : `${opt.percent}% (${opt.count}票)`;
        const bgOpacity = isBlind ? 0 : 0.15;
        
        html += `
        <div class="option-card" 
             id="opt-${opt.id}"
             onclick="handleVote(${opt.id})" 
             style="border-left: 5px solid ${opt.color}">
             
            <div class="stamp-mark" style="display:none;">已選</div>
            
            <div class="progress-bg" style="width: ${displayWidth}%; background-color: ${opt.color}; opacity: ${bgOpacity};"></div>
            <div class="option-content">
                <span class="option-text">${opt.text}</span>
                <span class="vote-stats" style="${isBlind ? 'color:#cbd5e1' : ''}">${displayText}</span>
            </div>
        </div>`;
    });
    
    if(optionsContainer) {
        optionsContainer.innerHTML = html;
        updateSelectionUI();
        if (state.status === 'ended') {
            Array.from(optionsContainer.children).forEach(child => child.style.pointerEvents = 'none');
        }
    }
}

function updateSelectionUI() {
    if (!optionsContainer) return;
    const cards = optionsContainer.querySelectorAll('.option-card');
    cards.forEach(card => {
        const optId = parseInt(card.id.replace('opt-', ''));
        const isSelected = myVotes.includes(optId);
        const stamp = card.querySelector('.stamp-mark');
        
        if (isSelected) {
            card.classList.add('selected');
            if(stamp) stamp.style.display = 'block';
        } else {
            card.classList.remove('selected');
            if(stamp) stamp.style.display = 'none';
        }
    });
}

function handleVote(optionId) {
    if (statusTextEl && statusTextEl.textContent.includes('結束')) return;
    if (navigator.vibrate) navigator.vibrate(15);

    if (currentSettings.allowMulti) {
        if (myVotes.includes(optionId)) myVotes = myVotes.filter(id => id !== optionId);
        else myVotes.push(optionId);
    } else {
        myVotes = [optionId];
    }
    
    updateSelectionUI();
    // 提交時傳送 username
    socket.emit('submit-vote', { votes: myVotes, username: currentUsername });
}

function showToast(msg) {
    if(!toastEl) return;
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    setTimeout(() => toastEl.style.opacity = '0', 2000);
}

function launchConfetti() {
    if(typeof confetti === 'function') {
        confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
    }
}

// --- 3. 主持人邏輯 ---
if (isHostPage) {
    const authOverlay = document.getElementById('host-auth-overlay');
    const pwdInput = document.getElementById('host-password-input');
    const loginBtn = document.getElementById('host-login-submit');
    const errorMsg = document.getElementById('login-error-msg');

    function attemptLogin() {
        const pwd = pwdInput.value;
        if (!pwd) return;
        socket.emit('host-login', pwd);
    }

    loginBtn.addEventListener('click', attemptLogin);
    pwdInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') attemptLogin(); });

    socket.on('host-login-success', (data) => {
        authOverlay.style.opacity = '0';
        setTimeout(() => authOverlay.remove(), 500);
        document.getElementById('host-pin-display').textContent = data.pin;
        currentPin = data.pin; 
        currentUsername = 'HOST'; // 主持人也給個名字
        socket.emit('join', { pin: data.pin, username: 'HOST' }); 
        showToast('🔓 控制台已解鎖');
    });

    socket.on('host-login-fail', () => {
        errorMsg.style.opacity = '1';
        pwdInput.value = '';
        pwdInput.focus();
        pwdInput.style.animation = 'shake 0.5s';
        setTimeout(() => pwdInput.style.animation = '', 500);
    });

    // 主持人控制功能 (保持不變)
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
        const url = window.location.href.replace('host.html', 'participant.html') + '?mode=projector';
        window.open(url, 'ProjectorWindow', 'width=1024,height=768');
    });

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
}
