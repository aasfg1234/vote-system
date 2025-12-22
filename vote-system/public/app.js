const socket = io();

// --- 1. 基礎設定 ---
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('clean') === 'true') {
    const style = document.createElement('style');
    style.innerHTML = `::-webkit-scrollbar { display: none; } body { -ms-overflow-style: none; scrollbar-width: none; }`;
    document.head.appendChild(style);
}

// 變數
let myVotes = [];
let currentSettings = {};
let lastStatus = 'waiting';
let currentVoteId = 0; 
let currentPin = '';
let currentUsername = '';
let currentPresets = []; 
let hasConfirmedResult = false; 
let lastServerState = null;     
let currentFontSize = parseFloat(localStorage.getItem('vote_font_scale')) || 1.0;
document.documentElement.style.fontSize = `${currentFontSize * 16}px`;
const deviceId = getDeviceId();

// 頁面判斷
const isHostPage = document.body.id === 'host-page';
const isParticipantPage = document.body.id === 'participant-page';
const isAdminPage = document.body.id === 'admin-page'; 
const isProjector = urlParams.get('mode') === 'projector';
if (isProjector) document.body.classList.add('projector-mode');

// --- 輔助函式 ---
function getDeviceId() {
    let id = localStorage.getItem('vote_device_id');
    if (!id) {
        id = 'dev_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
        localStorage.setItem('vote_device_id', id);
    }
    return id;
}
const quotes = ["「人生不是選擇題，而是申論題。」", "「選擇本身就是一種放棄。」", "「聽從你內心的聲音。」", "「慢慢來，比較快。」", "「重要的不是去哪裡，而是和誰一起去。」"];
function getRandomQuote() { return quotes[Math.floor(Math.random() * quotes.length)]; }
const getEl = (id) => document.getElementById(id);
function showToast(msg) {
    const t = getEl('toast'); if(!t) return;
    t.textContent = msg; t.style.opacity = '1';
    setTimeout(() => t.style.opacity = '0', 2000);
}

// --- 字體調整 ---
const fontUpBtn = getEl('font-up'); 
const fontDownBtn = getEl('font-down'); 
if(fontUpBtn) fontUpBtn.addEventListener('click', () => adjustFont(0.1));
if(fontDownBtn) fontDownBtn.addEventListener('click', () => adjustFont(-0.1));
function adjustFont(delta) {
    currentFontSize += delta;
    if (currentFontSize < 0.6) currentFontSize = 0.6;
    if (currentFontSize > 2.2) currentFontSize = 2.2;
    document.documentElement.style.fontSize = `${currentFontSize * 16}px`;
    localStorage.setItem('vote_font_scale', currentFontSize);
    showToast(`字體大小: ${Math.round(currentFontSize * 100)}%`);
}

// ==========================
// A. 與會者頁面邏輯
// ==========================
if (isParticipantPage) {
    const loginScreen = getEl('login-screen');
    const voteScreen = getEl('vote-screen');
    const storedPin = localStorage.getItem('vote_pin');
    const storedName = localStorage.getItem('vote_username');
    
    // 判斷是否為預覽模式
    const isPreview = urlParams.get('preview') === 'true';

    // 只有在「不是預覽模式」且「有儲存資料」時才自動登入
    if (!isPreview && storedPin && storedName) {
        currentPin = storedPin;
        currentUsername = storedName;
        loginScreen.innerHTML = `<h2 style="text-align:center; margin-top:50px; color:var(--primary);">↻ 正在恢復連線...</h2>`;
        socket.emit('join', { pin: currentPin, username: currentUsername, deviceId: deviceId });
    }

    const joinBtn = getEl('join-btn');
    if (joinBtn) {
        joinBtn.addEventListener('click', () => {
            const pin = getEl('pin-input').value;
            const username = getEl('username-input').value.trim();
            if (!username) return showToast('請輸入姓名');
            if (pin.length !== 4) return showToast('請輸入 4 位數 PIN');
            
            localStorage.setItem('vote_pin', pin);
            localStorage.setItem('vote_username', username);
            currentPin = pin;
            currentUsername = username;
            socket.emit('join', { pin, username, deviceId });
        });
    }

    getEl('leave-btn')?.addEventListener('click', () => {
        if (confirm('確定要離開會議嗎？')) {
            logout();
        }
    });

    socket.on('joined', (data) => {
        if (data.success) {
            loginScreen.classList.add('hidden');
            voteScreen.classList.remove('hidden');
        } else {
            showToast(data.error);
            if (!isPreview) {
                localStorage.removeItem('vote_pin');
                setTimeout(() => location.href = 'index.html', 1500);
            } else {
                getEl('pin-input').value = '';
            }
        }
    });

    socket.on('force-terminated', (reason) => {
        renderTerminatedScreen(reason);
    });
}

// ==========================
// B. 主持人頁面邏輯 (Host)
// ==========================
if (isHostPage) {
    const authOverlay = getEl('host-auth-overlay');
    const createBtn = getEl('create-meeting-btn');
    const nameInput = getEl('host-name-input');
    
    const storedHostPin = localStorage.getItem('vote_host_pin');
    if (storedHostPin) {
        getEl('host-auth-overlay').innerHTML = `
            <div class="container" style="max-width:400px; text-align:center; padding:50px;">
                <div style="font-size:3rem; margin-bottom:20px;">🔄</div>
                <h2 style="margin-bottom:10px;">正在恢復會議</h2>
                <p style="color:var(--text-light); margin-bottom:30px;">PIN: ${storedHostPin}</p>
                <p style="font-size:0.9rem; color:#999;">連線中...</p>
                <button onclick="clearHostData()" class="btn" style="background:transparent; border:1px solid #ccc; color:#666; margin-top:20px;">取消並建立新會議</button>
            </div>
        `;
        socket.emit('host-resume', storedHostPin);
    }

    window.clearHostData = function() {
        localStorage.removeItem('vote_host_pin');
        localStorage.removeItem('vote_host_name');
        location.reload();
    }

    createBtn.addEventListener('click', () => {
        const name = nameInput.value.trim();
        if (!name) return showToast('請輸入會議名稱');
        socket.emit('create-meeting', name);
    });

    socket.on('create-success', (data) => {
        authOverlay.style.opacity = '0';
        setTimeout(() => authOverlay.remove(), 500);
        getEl('host-pin-display').textContent = data.pin;
        getEl('host-name-display').textContent = data.hostName;
        currentPin = data.pin;
        currentUsername = data.hostName;
        localStorage.setItem('vote_host_pin', data.pin);
        localStorage.setItem('vote_host_name', data.hostName);
        showToast('會議室建立成功');
    });

    socket.on('host-resume-success', (data) => {
        authOverlay.style.opacity = '0';
        setTimeout(() => authOverlay.remove(), 500);
        getEl('host-pin-display').textContent = data.pin;
        getEl('host-name-display').textContent = data.hostName;
        currentPin = data.pin;
        currentUsername = data.hostName;
        if(data.history) renderHistory(data.history);
        showToast('歡迎回來，會議連線已恢復');
    });

    socket.on('host-resume-fail', () => {
        localStorage.removeItem('vote_host_pin');
        localStorage.removeItem('vote_host_name');
        location.reload();
    });

    const settingsModal = getEl('settings-modal');
    getEl('open-settings-btn')?.addEventListener('click', () => settingsModal.classList.remove('hidden'));
    getEl('close-settings-btn')?.addEventListener('click', () => settingsModal.classList.add('hidden'));

    getEl('save-host-name-btn')?.addEventListener('click', () => {
        const newName = getEl('new-host-name').value;
        if (newName.trim()) socket.emit('change-host-name', newName.trim());
    });

    getEl('add-preset-btn')?.addEventListener('click', () => {
        const name = getEl('new-preset-name').value;
        const question = getEl('new-preset-question').value;
        const opts = getEl('new-preset-options').value;
        if (name && question && opts) {
            socket.emit('add-preset', { name, question, options: opts.split(',') });
            showToast('樣板已新增');
        }
    });

    socket.on('host-name-updated', (n) => {
        getEl('host-name-display').textContent = n;
        localStorage.setItem('vote_host_name', n);
        showToast('名稱更新');
    });

    getEl('start-vote-btn')?.addEventListener('click', () => {
        const question = getEl('h-question').value;
        const opts = Array.from(document.querySelectorAll('.opt-text')).map(i => i.value).filter(v => v.trim());
        if (!question || opts.length < 2) return showToast('資料不完整');
        const colors = ['#84a98c', '#6b705c', '#d66853', '#d4af37', '#2c2c2c', '#8e8d8a'];
        
        socket.emit('start-vote', {
            question,
            options: opts.map((t, i) => ({ text: t, color: colors[i % colors.length] })),
            duration: parseInt(getEl('h-timer').value) || 0,
            allowMulti: getEl('h-multi').checked,
            blindMode: getEl('h-blind').checked
        });
    });

    getEl('stop-vote-btn')?.addEventListener('click', () => socket.emit('stop-vote'));
    getEl('clear-form-btn')?.addEventListener('click', () => {
        getEl('h-question').value = '';
        document.querySelectorAll('.opt-text').forEach(i => i.value = '');
    });
    
    getEl('terminate-btn')?.addEventListener('click', () => {
        if(confirm('確定要結束會議？這將強制所有人退出。')) {
            socket.emit('request-export');
            socket.emit('terminate-meeting');
            localStorage.removeItem('vote_host_pin');
            localStorage.removeItem('vote_host_name');
        }
    });
    
    getEl('export-btn')?.addEventListener('click', () => socket.emit('request-export'));
    
    socket.on('export-data', (csv) => {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
        link.download = `Result_${currentPin}.csv`;
        link.click();
    });

    socket.on('force-terminated', (reason) => {
        alert(`會議已被強制關閉：${reason}`);
        localStorage.removeItem('vote_host_pin');
        localStorage.removeItem('vote_host_name');
        location.href = 'index.html';
    });
}

// ==========================
// C. 管理員頁面邏輯
// ==========================
if (isAdminPage) {
    const authOverlay = getEl('admin-auth-overlay');
    const pwdInput = getEl('admin-password-input');
    
    getEl('admin-login-submit').addEventListener('click', () => {
        socket.emit('admin-login', pwdInput.value);
    });

    socket.on('admin-login-fail', () => {
        const msg = getEl('login-error-msg');
        msg.style.opacity = '1';
        pwdInput.classList.add('shake');
        setTimeout(()=> pwdInput.classList.remove('shake'), 500);
    });

    socket.on('admin-login-success', () => {
        authOverlay.style.opacity = '0';
        setTimeout(() => authOverlay.remove(), 500);
        showToast('管理員登入成功');
    });

    socket.on('admin-list-update', (list) => {
        const container = getEl('meeting-list-body');
        if (!container) return;
        
        if (list.length === 0) {
            container.innerHTML = '<p style="text-align:center; padding:20px; color:#ccc;">目前沒有進行中的會議</p>';
            return;
        }

        let html = '';
        list.forEach(m => {
            let statusClass = 'status-waiting';
            if (m.status === 'voting') statusClass = 'status-voting';
            if (m.status === 'terminated') statusClass = 'status-ended';

            html += `
            <div class="mt-list-item">
                <div style="font-weight:bold; color:var(--primary);">${m.pin}</div>
                <div>${m.hostName}</div>
                <div><span class="status-tag ${statusClass}">${m.status}</span></div>
                <div>👤 ${m.activeUsers}</div>
                <div class="timeout-control">
                    <input type="number" class="timeout-input" value="${m.timeoutSetting}" 
                           onchange="updateTimeout('${m.pin}', this.value)"> hr
                    <span style="font-size:0.8rem; color:#999;">(剩 ${m.remainingTime}分)</span>
                </div>
                <div>
                    <button class="btn btn-stop" style="padding:5px 10px; font-size:0.8rem; margin:0;" 
                            onclick="terminateMeeting('${m.pin}')">關閉</button>
                </div>
            </div>`;
        });
        container.innerHTML = html;
    });

    window.updateTimeout = function(pin, hours) {
        socket.emit('admin-update-timeout', { pin, hours });
        showToast('超時設定已更新');
    }

    window.terminateMeeting = function(pin) {
        if (confirm(`確定要強制關閉會議 ${pin} 嗎？`)) {
            socket.emit('admin-terminate', pin);
        }
    }

    getEl('change-admin-pwd-btn')?.addEventListener('click', () => {
        const pwd = getEl('new-admin-pwd').value;
        if(pwd) socket.emit('admin-change-password', pwd);
    });

    getEl('add-global-preset-btn')?.addEventListener('click', () => {
        const name = getEl('g-preset-name').value;
        const q = getEl('g-preset-q').value;
        const opt = getEl('g-preset-opt').value;
        if (name && q && opt) {
            socket.emit('admin-add-preset', { name, question: q, options: opt.split(',') });
            showToast('模板已新增');
        }
    });

    socket.on('admin-msg', (msg) => showToast(msg));
}

// ==========================
// D. 共用與渲染 (核心)
// ==========================
window.applyPreset = function(index) {
    if (!currentPresets[index]) return;
    const p = currentPresets[index];
    getEl('h-question').value = p.question;
    const inputs = document.querySelectorAll('.opt-text');
    inputs.forEach(i => i.value = '');
    p.options.forEach((t, i) => { if(inputs[i]) inputs[i].value = t; });
    showToast(`套用：${p.name}`);
};

socket.on('history-update', (history) => {
    if (isHostPage) {
        renderHistory(history);
    }
});

// [修復] 歷史紀錄顯示 (含最高票標示)
function renderHistory(history) {
    const container = getEl('history-container');
    if (!container) return;
    if (!history || history.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:#ccc; font-size:0.8rem;">尚未有歸檔紀錄</p>';
        return;
    }
    let html = '';
    // 顯示最新的在上面
    [...history].reverse().forEach(record => {
        const timeStr = new Date(record.timestamp).toLocaleTimeString();
        
        // 1. 計算該場歷史紀錄的最高票數
        const maxVotes = Math.max(...record.options.map(o => o.count));

        let optionsSummary = '';
        record.options.forEach(opt => {
             // 2. 判斷是否為最高票 (需大於0)
             const isWinner = maxVotes > 0 && opt.count === maxVotes;
             
             // 3. 設定樣式：贏家金色底+粗體；輸家灰色
             const rowStyle = isWinner 
                ? 'font-weight:bold; color:var(--text-main); background:#fffdf0; border:1px solid #d4af37; border-radius:4px; padding:4px 8px;' 
                : 'color:#64748b; padding:2px 8px;';
             
             const icon = isWinner ? '👑 ' : '';

             optionsSummary += `<div style="display:flex; justify-content:space-between; font-size:0.85rem; margin-top:4px; align-items:center; ${rowStyle}">
                <span>${icon}${opt.text}</span>
                <span>${opt.count} 票</span>
             </div>`;
        });
        html += `
        <div class="history-card" style="background:#fff; border:1px solid #eee; padding:15px; margin-bottom:10px; border-radius:4px;">
            <div class="history-title" style="font-weight:bold; margin-bottom:5px; color:var(--text-main);">${record.question}</div>
            <div class="history-stats" style="font-size:0.85rem; color:#999;">🕒 ${timeStr} | 🗳️ 總票數: ${record.totalVotes}</div>
            <div style="margin-top:10px; border-top:1px solid #eee; padding-top:8px;">${optionsSummary}</div>
        </div>`;
    });
    container.innerHTML = html;
}

// [渲染結束畫面]
function renderTerminatedScreen(reason) {
    const optionsContainer = getEl('options-container');
    if (optionsContainer) {
        optionsContainer.className = '';
        const reasonHtml = reason ? `<p style="font-size:0.9rem; color:var(--danger); margin-top:10px;">(${reason})</p>` : '';
        optionsContainer.innerHTML = `
            <div style="text-align:center; padding:50px 20px;">
                <div style="font-size:3rem; margin-bottom:20px;">🏁</div>
                <h2 style="color:var(--text-main); margin-bottom:10px;">會議已結束</h2>
                <p style="color:var(--text-light);">感謝您的參與</p>
                ${reasonHtml}
                ${isHostPage ? `
                    <p style="font-size:0.9rem; margin-top:20px; color:var(--success);">✓ 報表已自動下載</p>
                    <button onclick="logout()" class="btn" style="margin-top:20px; background:var(--text-main);">🏠 回首頁</button>
                ` : ''}
                ${isParticipantPage ? '<button onclick="logout()" class="btn" style="margin-top:30px;">🏠 回首頁</button>' : ''}
            </div>
        `;
    }
    const qEl = getEl('question-text'); if(qEl) qEl.textContent = '';
    const stEl = getEl('status-text'); if(stEl) stEl.textContent = '已結束';
    const lBtn = getEl('leave-btn'); if(lBtn) lBtn.style.display = 'none';
}

socket.on('state-update', (state) => {
    // 1. 主持人頁面更新
    if (isHostPage) {
        getEl('monitor-count').textContent = state.joinedCount;
        getEl('monitor-total').textContent = state.totalVotes;
        if (state.presets) {
            currentPresets = state.presets;
            const btnContainer = getEl('preset-buttons');
            if(btnContainer) {
                btnContainer.innerHTML = state.presets.map((p, i) => 
                    `<button class="preset-btn" onclick="applyPreset(${i})">${p.name}</button>`
                ).join('');
            }
        }
        const monitorOpts = getEl('monitor-options');
        if (state.status === 'waiting') {
            monitorOpts.innerHTML = '<p style="text-align:center; font-size:0.8rem; color:#ccc;">等待發布...</p>';
        } else {
            let max = Math.max(...state.options.map(o=>o.count));
            monitorOpts.innerHTML = state.options.map(opt => {
                const isWin = state.status === 'ended' && max > 0 && opt.count === max;
                const voters = state.hostVoterMap[opt.id] || [];
                return `<div style="position:relative; margin-bottom:6px; padding:8px 10px; border:1px solid #eee; background:#fff; ${isWin?'border-color:var(--accent);background:#fffdf0;':''}">
                    <div style="position:absolute; top:0; left:0; height:100%; width:${opt.percent}%; background:${opt.color}; opacity:0.15;"></div>
                    <div style="position:relative; display:flex; justify-content:space-between; font-size:0.85rem;">
                        <span>${opt.text}</span><span>${opt.count}票 (${opt.percent}%)</span>
                    </div>
                    ${voters.length ? `<div style="font-size:0.75rem; color:#64748b; margin-top:4px;">${voters.join(', ')}</div>` : ''}
                </div>`;
            }).join('');
        }
        return;
    }

    // 2. 與會者頁面更新
    if (!getEl('vote-screen')) return;
    
    if (state.status === 'terminated') {
        renderTerminatedScreen();
        return;
    }

    currentSettings = state.settings;
    if (state.voteId !== currentVoteId) {
        myVotes = [];
        currentVoteId = state.voteId;
        hasConfirmedResult = false; 
        updateSelectionUI();
    }
    
    lastServerState = state;

    getEl('total-votes').textContent = state.totalVotes;
    getEl('joined-count').textContent = state.joinedCount;
    const timer = getEl('timer');
    if(timer) timer.textContent = state.timeLeft + 's';

    if(lastStatus === 'voting' && state.status === 'ended') {
         if(typeof confetti === 'function') confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
    }
    lastStatus = state.status;

    const showWait = state.status === 'waiting' || (state.status === 'ended' && hasConfirmedResult);

    if (showWait) {
        getEl('question-text').textContent = '';
        getEl('options-container').innerHTML = `
            <div style="text-align:center; padding:60px 20px; color:var(--text-light);">
                <div style="font-size:1.5rem; margin-bottom:15px;">☕</div>
                <p style="font-style:italic;">${getRandomQuote()}</p>
                <p style="font-size:0.9rem; opacity:0.7; margin-top:10px;">等待下一題...</p>
            </div>`;
        getEl('status-text').textContent = state.status === 'waiting' ? '準備中' : '等待下一題';
        return;
    }

    getEl('question-text').textContent = state.question;
    const statusTxt = getEl('status-text');
    statusTxt.textContent = state.status === 'voting' ? (currentSettings.blindMode ? '投票中 (盲測)' : '投票中') : '已結束';
    statusTxt.style.color = state.status === 'voting' ? 'var(--success)' : 'var(--danger)';

    let max = Math.max(...state.options.map(o => o.count));
    const container = getEl('options-container');
    
    container.innerHTML = state.options.map(opt => {
        const isBlind = opt.percent === -1;
        const percent = isBlind ? '?' : opt.percent;
        const count = isBlind ? '' : `${opt.count}票`;
        const isWin = state.status === 'ended' && max > 0 && opt.count === max;
        
        return `
        <div class="option-card ${isWin ? 'winner-card' : ''} ${state.status==='ended' && !isWin ? 'loser-card' : ''}" 
             id="opt-${opt.id}" onclick="handleVote(${opt.id})" style="border-left: 5px solid ${opt.color};">
            ${isWin ? '<div class="winner-icon">👑</div>' : ''}
            <div class="stamp-mark" style="display:${myVotes.includes(opt.id)?'block':'none'}">已選</div>
            <div class="progress-bg" style="width:${isBlind?0:opt.percent}%; background:${opt.color};"></div>
            <div class="option-content">
                <span class="option-text">${opt.text}</span>
                <div style="text-align:right;">
                    <span class="opt-percent">${percent}${isBlind?'':'<small>%</small>'}</span>
                    <span class="opt-count">${count}</span>
                </div>
            </div>
        </div>`;
    }).join('');

    if (state.status === 'ended') {
        container.innerHTML += `<div style="text-align:center; margin-top:20px;">
            <button class="btn" onclick="confirmResult()" style="width:auto; padding:10px 30px;">👌 收到</button>
        </div>`;
    }
    
    if (state.status === 'ended') {
         container.querySelectorAll('.option-card').forEach(c => c.style.cursor = 'default');
    } else {
        updateSelectionUI();
    }
});

socket.on('timer-tick', (t) => {
    const el = getEl('timer'); if(el) el.textContent = t + 's';
    const hEl = getEl('h-timer'); if(hEl && document.activeElement !== hEl) hEl.value = t;
});

function updateSelectionUI() {
    const cards = document.querySelectorAll('.option-card');
    cards.forEach(card => {
        const id = parseInt(card.id.split('-')[1]);
        if (myVotes.includes(id)) {
            card.classList.add('selected');
            const stamp = card.querySelector('.stamp-mark');
            if(stamp) stamp.style.display = 'block';
        } else {
            card.classList.remove('selected');
            const stamp = card.querySelector('.stamp-mark');
            if(stamp) stamp.style.display = 'none';
        }
    });
}

window.handleVote = function(id) {
    if (!getEl('vote-screen') || document.querySelector('.winner-card')) return;
    if (navigator.vibrate) navigator.vibrate(10);
    
    if (currentSettings.allowMulti) {
        if (myVotes.includes(id)) myVotes = myVotes.filter(v => v !== id);
        else myVotes.push(id);
    } else {
        myVotes = [id];
    }
    updateSelectionUI();
    socket.emit('submit-vote', { pin: currentPin, username: currentUsername, deviceId, votes: myVotes });
}

window.confirmResult = function() {
    console.log("Button Clicked"); 
    hasConfirmedResult = true;
    if (lastServerState) {
        const listeners = socket.listeners('state-update');
        if (listeners && listeners.length > 0) {
            listeners[0](lastServerState);
        } else {
            location.reload();
        }
    }
}

window.logout = function() {
    localStorage.removeItem('vote_pin');
    localStorage.removeItem('vote_username');
    location.href = 'index.html';
}
