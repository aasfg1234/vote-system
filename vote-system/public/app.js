const socket = io();

// DOM Elements
const loginScreen = document.getElementById('login-screen');
const voteScreen = document.getElementById('vote-screen');
const pinInput = document.getElementById('pin-input');
const usernameInput = document.getElementById('username-input');
const joinBtn = document.getElementById('join-btn');
const leaveBtn = document.getElementById('leave-btn');
const questionEl = document.getElementById('question-text');
const optionsContainer = document.getElementById('options-container');
const totalVotesEl = document.getElementById('total-votes');
const joinedCountEl = document.getElementById('joined-count'); 
const timerEl = document.getElementById('timer');
const statusTextEl = document.getElementById('status-text');
const toastEl = document.getElementById('toast');
const historyContainer = document.getElementById('history-container');
const presetButtonsContainer = document.getElementById('preset-buttons'); // 新增

let myVotes = [];
let currentSettings = {};
let lastStatus = 'waiting';
let currentVoteId = 0; 
let currentPin = '';
let currentUsername = '';
// 儲存目前的樣板列表，方便呼叫
let currentPresets = []; 

const isHostPage = document.body.id === 'host-page';
const isParticipantPage = document.body.id === 'participant-page';

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

// 強制自動登入邏輯
if (isParticipantPage) {
    const storedPin = localStorage.getItem('vote_pin');
    const storedName = localStorage.getItem('vote_username');

    if (storedPin && storedName) {
        currentPin = storedPin;
        currentUsername = storedName;
        loginScreen.innerHTML = `<h2 style="text-align:center; margin-top:50px; color:var(--primary);">↻ 正在恢復連線...</h2><p style="text-align:center; color:var(--text-light);">${currentUsername}</p>`;
        socket.emit('join', { pin: currentPin, username: currentUsername });
    }

    if (joinBtn) {
        joinBtn.addEventListener('click', () => {
            const pin = pinInput.value;
            const username = usernameInput.value.trim();
            if (!username) return showToast('請輸入姓名');
            if (pin.length !== 4) return showToast('請輸入 4 位數 PIN');
            
            localStorage.setItem('vote_pin', pin);
            localStorage.setItem('vote_username', username);
            currentPin = pin;
            currentUsername = username;
            socket.emit('join', { pin: pin, username: username });
        });
    }

    if (leaveBtn) {
        leaveBtn.addEventListener('click', () => {
            if (confirm('確定要離開會議嗎？')) {
                logout();
            }
        });
    }

    socket.on('joined', (data) => {
        if (data.success) {
            loginScreen.classList.add('hidden');
            voteScreen.classList.remove('hidden');
        } else {
            showToast(data.error);
            localStorage.removeItem('vote_pin');
            if (data.error === '會議已結束') {
                setTimeout(() => location.href = 'index.html', 2000);
            } else {
                setTimeout(() => location.reload(), 1000);
            }
        }
    });
}

socket.on('connect', () => {
    if (currentPin && currentUsername) {
        socket.emit('join', { pin: currentPin, username: currentUsername });
    }
});

// 狀態渲染
socket.on('state-update', (state) => {
    if (!voteScreen && !isHostPage) return; 
    renderMeeting(state);
    
    // 主持人：更新歷史紀錄 與 樣板按鈕
    if (isHostPage) {
        if (state.history) renderHistory(state.history);
        if (state.presets) renderPresets(state.presets);
    }
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
    if (state.status === 'terminated') {
        if (optionsContainer) {
            optionsContainer.innerHTML = `
                <div style="text-align:center; padding:50px 20px;">
                    <div style="font-size:3rem; margin-bottom:20px;">🏁</div>
                    <h2 style="color:var(--text-main); margin-bottom:10px;">會議已結束</h2>
                    <p style="color:var(--text-light);">感謝您的參與</p>
                    ${isHostPage ? '<p style="font-size:0.8rem; margin-top:20px; color:#aaa;">(主持人可至下方下載完整 CSV)</p>' : ''}
                    ${isParticipantPage ? '<button onclick="location.href=\'index.html\'" class="btn" style="margin-top:30px;">回首頁</button>' : ''}
                </div>
            `;
        }
        if (questionEl) questionEl.textContent = '';
        if (statusTextEl) statusTextEl.textContent = '已結束';
        if (leaveBtn) leaveBtn.style.display = 'none';
        return;
    }

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

    let maxVotes = 0;
    if (state.status === 'ended') {
        maxVotes = Math.max(...state.options.map(o => o.count));
    }

    let html = '';
    state.options.forEach(opt => {
        const isBlind = opt.percent === -1;
        const displayWidth = isBlind ? 0 : opt.percent;
        const displayText = isBlind ? '???' : `${opt.percent}% (${opt.count}票)`;
        const bgOpacity = isBlind ? 0 : 0.15;
        
        let voterTagsHtml = '';
        if (isHostPage && state.hostVoterMap && state.hostVoterMap[opt.id]) {
            voterTagsHtml = '<div class="voter-tags">';
            state.hostVoterMap[opt.id].forEach(name => {
                voterTagsHtml += `<span class="voter-tag">${name}</span>`;
            });
            voterTagsHtml += '</div>';
        }

        let resultClass = '';
        let crownHtml = '';
        if (state.status === 'ended' && maxVotes > 0) {
            if (opt.count === maxVotes) {
                resultClass = 'winner-card';
                crownHtml = '<div class="winner-icon">👑</div>';
            } else {
                resultClass = 'loser-card';
            }
        }

        html += `
        <div class="option-card ${resultClass}" 
             id="opt-${opt.id}"
             onclick="handleVote(${opt.id})" 
             style="border-left: 5px solid ${opt.color}">
             
            ${crownHtml}
            <div class="stamp-mark" style="display:none;">已選</div>
            
            <div class="progress-bg" style="width: ${displayWidth}%; background-color: ${opt.color}; opacity: ${bgOpacity};"></div>
            <div class="option-content">
                <span class="option-text">${opt.text}</span>
                <span class="vote-stats" style="${isBlind ? 'color:#cbd5e1' : ''}">${displayText}</span>
            </div>
            ${voterTagsHtml}
        </div>`;
    });
    
    if(optionsContainer) {
        optionsContainer.innerHTML = html;
        updateSelectionUI();
        if (state.status === 'ended' || isHostPage) { 
             if (state.status === 'ended') {
                Array.from(optionsContainer.children).forEach(child => child.style.pointerEvents = 'none');
             }
        }
    }
}

function renderHistory(history) {
    if (!historyContainer) return;
    if (history.length === 0) {
        historyContainer.innerHTML = '<p style="text-align:center; color:#ccc; font-size:0.9rem;">尚未有歸檔紀錄</p>';
        return;
    }

    let html = '';
    [...history].reverse().forEach(record => {
        const timeStr = new Date(record.timestamp).toLocaleTimeString();
        let optionsSummary = '';
        record.options.forEach(opt => {
             optionsSummary += `<div style="display:flex; justify-content:space-between; font-size:0.85rem; margin-top:4px; color:#64748b;">
                <span>${opt.text}</span>
                <span>${opt.count} 票</span>
             </div>`;
        });

        html += `
        <div class="history-card">
            <div class="history-title">${record.question}</div>
            <div class="history-stats">🕒 ${timeStr} | 🗳️ 總票數: ${record.totalVotes}</div>
            <div style="margin-top:10px; border-top:1px solid #eee; padding-top:5px;">
                ${optionsSummary}
            </div>
        </div>`;
    });
    historyContainer.innerHTML = html;
}

// 新增：渲染樣板按鈕
function renderPresets(presets) {
    if (!presetButtonsContainer) return;
    currentPresets = presets; // 更新本地快取
    
    let html = '';
    presets.forEach((preset, index) => {
        html += `<button class="preset-btn" onclick="applyPreset(${index})">${preset.name}</button>`;
    });
    presetButtonsContainer.innerHTML = html;
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

window.logout = function() {
    localStorage.removeItem('vote_pin');
    localStorage.removeItem('vote_username');
    location.href = 'index.html';
}

// 主持人頁面邏輯
if (isHostPage) {
    const authOverlay = document.getElementById('host-auth-overlay');
    const pwdInput = document.getElementById('host-password-input');
    const loginBtn = document.getElementById('host-login-submit');
    const errorMsg = document.getElementById('login-error-msg');
    const terminateBtn = document.getElementById('terminate-btn');
    
    // 設定視窗元素
    const settingsModal = document.getElementById('settings-modal');
    const openSettingsBtn = document.getElementById('open-settings-btn');
    const closeSettingsBtn = document.getElementById('close-settings-btn');
    const savePasswordBtn = document.getElementById('save-password-btn');
    const addPresetBtn = document.getElementById('add-preset-btn');
    
    // 設定視窗開關
    if (openSettingsBtn) {
        openSettingsBtn.addEventListener('click', () => settingsModal.classList.remove('hidden'));
        closeSettingsBtn.addEventListener('click', () => settingsModal.classList.add('hidden'));
    }

    // 修改密碼
    if (savePasswordBtn) {
        savePasswordBtn.addEventListener('click', () => {
            const newPwd = document.getElementById('new-host-password').value;
            if (newPwd.trim()) {
                socket.emit('change-password', newPwd);
            } else {
                showToast('密碼不能為空');
            }
        });
    }

    // 新增樣板
    if (addPresetBtn) {
        addPresetBtn.addEventListener('click', () => {
            const name = document.getElementById('new-preset-name').value;
            const question = document.getElementById('new-preset-question').value;
            const optionsStr = document.getElementById('new-preset-options').value;
            
            if (name && question && optionsStr) {
                const options = optionsStr.split(',').map(s => s.trim()).filter(s => s);
                socket.emit('add-preset', { name, question, options });
                showToast('樣板已新增');
                // 清空輸入框
                document.getElementById('new-preset-name').value = '';
                document.getElementById('new-preset-question').value = '';
                document.getElementById('new-preset-options').value = '';
            } else {
                showToast('請填寫完整資訊');
            }
        });
    }
    
    socket.on('password-updated', () => {
        showToast('密碼修改成功');
        document.getElementById('new-host-password').value = '';
    });

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
        currentUsername = 'HOST';
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

    if (terminateBtn) {
        terminateBtn.addEventListener('click', () => {
            if (confirm('確定要結束整場會議嗎？\n(這將會強制所有人退出)')) {
                socket.emit('terminate-meeting');
                showToast('會議已終止');
            }
        });
    }

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
        link.download = `會議結果匯總_${new Date().toISOString().slice(0,19).replace(/:/g,"-")}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });

    // 改寫：使用索引套用樣板
    window.applyPreset = function(index) {
        if (!currentPresets[index]) return;
        const preset = currentPresets[index];
        
        const qInput = document.getElementById('h-question');
        const optInputs = document.querySelectorAll('.opt-text');
        
        qInput.value = preset.question;
        // 清空選項
        optInputs.forEach(i => i.value = '');
        // 填入選項
        preset.options.forEach((optText, i) => {
            if (optInputs[i]) optInputs[i].value = optText;
        });
        
        showToast('已套用：' + preset.name);
    };
}
