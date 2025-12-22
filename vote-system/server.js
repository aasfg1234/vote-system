require('dotenv').config(); // [安全] 載入環境變數
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- [安全] 全域設定 (從環境變數讀取) ---
// 如果沒有設定環境變數，預設密碼為 8888
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '8888'; 
const PORT = process.env.PORT || 3000;
// 預設 3 小時 (毫秒)
const DEFAULT_TIMEOUT = parseInt(process.env.TIMEOUT_DURATION) || 3 * 60 * 60 * 1000;

// --- [安全] 速率限制器 (簡易版 In-Memory) ---
// 防止暴力破解密碼或惡意建立大量會議
class RateLimiter {
    constructor(limit, windowMs) {
        this.requests = new Map(); // IP -> { count, startTime }
        this.limit = limit;
        this.windowMs = windowMs;
    }

    check(ip) {
        const now = Date.now();
        const record = this.requests.get(ip);

        if (!record) {
            this.requests.set(ip, { count: 1, startTime: now });
            return true;
        }

        if (now - record.startTime > this.windowMs) {
            // 時間視窗已過，重置
            this.requests.set(ip, { count: 1, startTime: now });
            return true;
        }

        if (record.count >= this.limit) {
            return false; // 超過限制
        }

        record.count++;
        return true;
    }
}

// 設定限制：每分鐘最多 5 次登入嘗試，每分鐘最多建立 10 個會議
const loginLimiter = new RateLimiter(5, 60 * 1000); 
const createLimiter = new RateLimiter(10, 60 * 1000);

// --- 資料結構 ---
// Key: pin (String), Value: Meeting Object
const meetings = new Map();

// --- 預設樣板 ---
let globalPresets = [
    { name: "⭕ 是非題", question: "您是否同意此提案？", options: ["⭕ 同意", "❌ 不同意"] },
    { name: "📊 評分題", question: "請對本次活動進行評分", options: ["⭐️⭐️⭐️⭐️⭐️ 非常滿意", "⭐️⭐️⭐️⭐️ 滿意", "⭐️⭐️⭐️ 普通", "⭐️⭐️ 尚可", "⭐️ 待加強"] },
    { name: "🍱 午餐題", question: "今天午餐想吃什麼類別？", options: ["🍱 便當/自助餐", "🍜 麵食/水餃", "🍔 速食", "🥗 輕食/沙拉"] }
];

// --- [安全] 輸入驗證輔助函式 ---
function isValidString(str, maxLength = 100) {
    return typeof str === 'string' && str.trim().length > 0 && str.length <= maxLength;
}

function createMeetingState(pin, hostName) {
    // 確保 hostName 不會過長
    const safeHostName = isValidString(hostName, 50) ? hostName : 'HOST';
    
    return {
        pin: pin,
        hostName: safeHostName,
        status: 'waiting', 
        question: '',
        options: [], 
        settings: { allowMulti: false, blindMode: false, duration: 0 },
        timer: null,
        endTime: null,
        voteId: 0,
        hasArchived: false,
        history: [],
        voterRecords: new Map(),
        presets: [...globalPresets],
        // --- 超時控制 ---
        createdAt: Date.now(),
        lastActiveTime: Date.now(),
        timeoutDuration: DEFAULT_TIMEOUT 
    };
}

function generateUniquePin() {
    let pin;
    do {
        pin = Math.floor(1000 + Math.random() * 9000).toString();
    } while (meetings.has(pin));
    return pin;
}

function touchMeeting(meeting) {
    if (meeting) meeting.lastActiveTime = Date.now();
}

// --- 自動清理機制 (每分鐘檢查) ---
setInterval(() => {
    const now = Date.now();
    meetings.forEach((meeting, pin) => {
        if (meeting.status !== 'terminated') {
            if (now - meeting.lastActiveTime > meeting.timeoutDuration) {
                console.log(`[Auto-Close] Meeting ${pin} inactive for too long.`);
                terminateMeeting(meeting, 'auto-timeout');
            }
        }
    });
}, 60 * 1000);

// --- 核心邏輯 ---
function archiveCurrentVote(meeting) {
    if (!meeting || !meeting.question || meeting.hasArchived) return;
    const snapshot = {
        question: meeting.question,
        options: JSON.parse(JSON.stringify(meeting.options)), 
        timestamp: new Date().toISOString(),
        totalVotes: 0,
        voterDetails: {} 
    };
    let total = 0;
    meeting.voterRecords.forEach((data) => {
        if (data.votes && data.votes.length > 0) {
            total++;
            snapshot.voterDetails[data.username] = data.votes;
        }
    });
    snapshot.totalVotes = total;
    meeting.history.push(snapshot);
    meeting.hasArchived = true;
    io.to(`${meeting.pin}-host`).emit('history-update', meeting.history);
}

function broadcastState(meeting) {
    if (!meeting) return;
    let totalVotes = 0;
    meeting.options.forEach(opt => opt.count = 0);
    const hostVoterMap = {}; 

    meeting.voterRecords.forEach((data) => {
        const votes = data.votes;
        const username = data.username;
        if (votes && votes.length > 0) {
            totalVotes++;
            votes.forEach(optId => {
                const opt = meeting.options.find(o => o.id === optId);
                if (opt) {
                    opt.count++;
                    if (!hostVoterMap[optId]) hostVoterMap[optId] = [];
                    hostVoterMap[optId].push(username);
                }
            });
        }
    });

    // 計算人數
    const roomName = `meeting-${meeting.pin}`;
    const allSockets = io.sockets.adapter.rooms.get(roomName);
    const hostRoomName = `${meeting.pin}-host`;
    const hostSockets = io.sockets.adapter.rooms.get(hostRoomName);
    let realUserCount = 0;
    if (allSockets) {
        allSockets.forEach(socketId => {
            if (!hostSockets || !hostSockets.has(socketId)) realUserCount++;
        });
    }

    const fullOptions = meeting.options.map(opt => ({
        id: opt.id, text: opt.text, color: opt.color, count: opt.count,
        percent: totalVotes === 0 ? 0 : Math.round((opt.count / totalVotes) * 100)
    }));
    
    const blindedOptions = meeting.options.map(opt => ({
        id: opt.id, text: opt.text, color: opt.color, count: -1, percent: -1
    }));

    const basePayload = {
        status: meeting.status,
        question: meeting.question,
        totalVotes: totalVotes,
        joinedCount: realUserCount, 
        settings: meeting.settings,
        timeLeft: meeting.endTime ? Math.max(0, Math.round((meeting.endTime - Date.now())/1000)) : 0,
        voteId: meeting.voteId
    };

    io.to(hostRoomName).emit('state-update', { 
        ...basePayload, options: fullOptions, hostVoterMap, presets: meeting.presets 
    });

    if (meeting.settings.blindMode && meeting.status === 'voting') {
        io.to(roomName).except(hostRoomName).emit('state-update', { ...basePayload, options: blindedOptions });
    } else {
        io.to(roomName).except(hostRoomName).emit('state-update', { ...basePayload, options: fullOptions });
    }
}

function terminateMeeting(meeting, reason = 'manual') {
    if (!meeting) return;
    archiveCurrentVote(meeting);
    if (meeting.timer) clearInterval(meeting.timer);
    
    meeting.status = 'terminated';
    meeting.question = '';
    meeting.endTime = null;
    
    broadcastState(meeting);
    
    // 如果是自動關閉，廣播給所有人包含主持人
    if (reason === 'auto-timeout') {
        io.to(`${meeting.pin}-host`).emit('force-terminated', '系統閒置過久自動關閉');
        io.to(`meeting-${meeting.pin}`).emit('force-terminated', '系統閒置過久自動關閉');
    }
    
    // 延遲刪除
    setTimeout(() => {
        meetings.delete(meeting.pin);
        broadcastAdminList(); // 更新管理員列表
    }, 1000 * 60 * 60); 
    
    broadcastAdminList();
}

function broadcastAdminList() {
    const list = [];
    meetings.forEach(m => {
        const idleTime = Date.now() - m.lastActiveTime;
        const remaining = Math.max(0, m.timeoutDuration - idleTime);
        list.push({
            pin: m.pin,
            hostName: m.hostName,
            status: m.status,
            activeUsers: io.sockets.adapter.rooms.get(`meeting-${m.pin}`)?.size || 0,
            remainingTime: Math.round(remaining / 1000 / 60), 
            timeoutSetting: Math.round(m.timeoutDuration / 1000 / 60 / 60) 
        });
    });
    io.to('admin-room').emit('admin-list-update', list);
}

// --- Socket 連線 ---
io.on('connection', (socket) => {
    // [安全] 取得 IP 位址 (考慮代理伺服器情況，Render/Heroku 需要 x-forwarded-for)
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    // 1. 與會者加入
    socket.on('join', (data) => {
        // [安全] 基本資料驗證
        if (!data || !data.pin || !data.username) return;
        const pin = String(data.pin).substring(0, 4); // 強制截斷
        const username = String(data.username).substring(0, 20);

        const meeting = meetings.get(pin);

        if (!meeting) {
            socket.emit('joined', { success: false, error: 'PIN 碼無效' });
            return;
        }
        if (meeting.status === 'terminated') {
            socket.emit('joined', { success: false, error: '會議已結束' });
            return;
        }

        socket.join(`meeting-${pin}`);
        socket.data.pin = pin;
        socket.data.username = username;
        touchMeeting(meeting);

        socket.emit('joined', { success: true });
        if (data.deviceId && meeting.status === 'voting') {
            const record = meeting.voterRecords.get(data.deviceId);
            if (record) socket.emit('vote-confirmed', record.votes);
        }
        broadcastState(meeting);
        broadcastAdminList();
    });

    // 2. 建立新會議室
    socket.on('create-meeting', (hostName) => {
        // [安全] 速率限制檢查
        if (!createLimiter.check(clientIp)) {
            // 可以選擇發送錯誤訊息給前端，這裡簡單處理
            return; 
        }

        const newPin = generateUniquePin();
        const newMeeting = createMeetingState(newPin, hostName);
        meetings.set(newPin, newMeeting);

        socket.data.pin = newPin;
        socket.data.isHost = true;

        socket.join(`meeting-${newPin}`);
        socket.join(`${newPin}-host`);

        socket.emit('create-success', { pin: newPin, hostName: newMeeting.hostName });
        broadcastState(newMeeting); 
        broadcastAdminList();
    });

    // 3. 主持人恢復連線 (Resume)
    socket.on('host-resume', (pin) => {
        const meeting = meetings.get(pin);
        if (meeting && meeting.status !== 'terminated') {
            // 重新綁定身分
            socket.data.pin = pin;
            socket.data.isHost = true;
            
            socket.join(`meeting-${pin}`);
            socket.join(`${pin}-host`);
            
            touchMeeting(meeting);
            
            // 告訴前端恢復成功，並傳回當前狀態
            socket.emit('host-resume-success', { 
                pin: pin, 
                hostName: meeting.hostName,
                history: meeting.history
            });
            broadcastState(meeting);
        } else {
            // 找不到或已結束
            socket.emit('host-resume-fail');
        }
    });

    // 4. 投票控制
    socket.on('start-vote', (data) => {
        const meeting = meetings.get(socket.data.pin);
        if (!meeting || !socket.data.isHost) return;
        touchMeeting(meeting);

        // [安全] 驗證選項數量
        if (!Array.isArray(data.options) || data.options.length < 2) return;

        archiveCurrentVote(meeting);
        meeting.voterRecords.clear();
        meeting.options.forEach(o => o.count = 0);
        
        meeting.status = 'voting';
        // [安全] 截斷過長的文字
        meeting.question = String(data.question).substring(0, 200);
        meeting.settings.allowMulti = !!data.allowMulti;
        meeting.settings.blindMode = !!data.blindMode;
        meeting.voteId = Date.now(); 
        meeting.hasArchived = false;
        
        meeting.options = data.options.map((opt, index) => ({
            id: index, 
            text: String(opt.text).substring(0, 100), // 選項長度限制
            color: opt.color, 
            count: 0
        }));

        if (data.duration > 0) {
            // [安全] 限制最大倒數時間為 1 小時 (3600秒)
            const safeDuration = Math.min(data.duration, 3600);
            meeting.endTime = Date.now() + (safeDuration * 1000);
            if (meeting.timer) clearInterval(meeting.timer);
            meeting.timer = setInterval(() => {
                const currentM = meetings.get(meeting.pin);
                if(!currentM) return;
                const left = Math.round((currentM.endTime - Date.now())/1000);
                if (left <= 0) {
                    if (currentM.timer) clearInterval(currentM.timer);
                    currentM.status = 'ended';
                    currentM.endTime = null;
                    archiveCurrentVote(currentM);
                    broadcastState(currentM);
                } else {
                    io.to(`meeting-${currentM.pin}`).emit('timer-tick', left);
                }
            }, 1000);
        } else {
            meeting.endTime = null;
            if (meeting.timer) clearInterval(meeting.timer);
        }
        broadcastState(meeting);
    });

    socket.on('stop-vote', () => {
        const meeting = meetings.get(socket.data.pin);
        if (meeting && socket.data.isHost) {
            touchMeeting(meeting);
            if (meeting.timer) clearInterval(meeting.timer);
            meeting.status = 'ended';
            meeting.endTime = null;
            archiveCurrentVote(meeting); 
            broadcastState(meeting);
        }
    });

    socket.on('terminate-meeting', () => {
        const meeting = meetings.get(socket.data.pin);
        if (meeting && socket.data.isHost) {
            terminateMeeting(meeting);
        }
    });

    socket.on('submit-vote', (data) => {
        const pin = socket.data.pin || data.pin; 
        const meeting = meetings.get(pin);
        if (!meeting || meeting.status !== 'voting') return;
        if (socket.data.isHost) return;
        
        touchMeeting(meeting);
        
        // [安全] 確保 votes 是陣列且內容合法 (防止注入攻擊)
        const safeVotes = Array.isArray(data.votes) 
            ? data.votes.filter(v => Number.isInteger(v)) 
            : [];

        meeting.voterRecords.set(data.deviceId, {
            username: String(data.username).substring(0, 20), 
            votes: safeVotes
        });
        broadcastState(meeting);
        socket.emit('vote-confirmed', safeVotes);
    });

    // --- CSV 匯出 ---
    socket.on('request-export', () => {
        const meeting = meetings.get(socket.data.pin);
        if (!meeting || !socket.data.isHost) return;
        touchMeeting(meeting);
        
        let csvContent = "\uFEFF題目,選項,票數,投票者名單\n"; 
        meeting.history.forEach(record => {
            record.options.forEach(opt => {
                const voters = [];
                for (const [name, choices] of Object.entries(record.voterDetails)) {
                    if (choices.includes(opt.id)) voters.push(name);
                }
                // [安全] 轉義 CSV 內容防止 CSV Injection
                const safeQ = record.question.replace(/"/g, '""');
                const safeOpt = opt.text.replace(/"/g, '""');
                csvContent += `"[歷史] ${safeQ}","${safeOpt}",${opt.count},"${voters.join('; ')}"\n`;
            });
            csvContent += `,,,\n`; 
        });
        socket.emit('export-data', csvContent);
    });

    // --- 管理員 API ---
    socket.on('admin-login', (pwd) => {
        // [安全] 速率限制檢查
        if (!loginLimiter.check(clientIp)) {
            socket.emit('admin-login-fail'); // 或發送特定錯誤訊息
            return;
        }

        if (pwd === ADMIN_PASSWORD) {
            socket.join('admin-room');
            socket.emit('admin-login-success');
            broadcastAdminList();
        } else {
            socket.emit('admin-login-fail');
        }
    });

    socket.on('admin-terminate', (targetPin) => {
        if (socket.rooms.has('admin-room')) {
            const meeting = meetings.get(targetPin);
            if (meeting) terminateMeeting(meeting, 'admin-force');
        }
    });

    socket.on('admin-update-timeout', (data) => {
        if (socket.rooms.has('admin-room')) {
            const meeting = meetings.get(data.pin);
            if (meeting) {
                // [安全] 限制最大與最小時間
                const hours = Math.max(0.5, Math.min(parseInt(data.hours), 24));
                meeting.timeoutDuration = hours * 60 * 60 * 1000;
                broadcastAdminList();
            }
        }
    });

    socket.on('admin-change-password', (newPwd) => {
        if (socket.rooms.has('admin-room')) {
            // 基於安全考量，現在不允許線上修改密碼，提示去改 .env
            socket.emit('admin-msg', '基於安全考量，請透過修改 Render 環境變數 (ADMIN_PASSWORD) 來變更密碼');
        }
    });

    socket.on('admin-add-preset', (preset) => {
        if (socket.rooms.has('admin-room')) {
            if(preset.name && preset.question && Array.isArray(preset.options)) {
                globalPresets.push(preset);
                meetings.forEach(m => {
                    m.presets.push(preset);
                    broadcastState(m); 
                });
                socket.emit('admin-msg', '全域模板已新增');
            }
        }
    });

    socket.on('disconnect', () => {
        const pin = socket.data.pin;
        if (pin) {
            const meeting = meetings.get(pin);
            if (meeting) setTimeout(() => broadcastState(meeting), 1000);
        }
        broadcastAdminList();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
