const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- 全域設定 ---
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '8888'; 
const PORT = process.env.PORT || 3000;
const DEFAULT_TIMEOUT = parseInt(process.env.TIMEOUT_DURATION) || 3 * 60 * 60 * 1000;
let MAX_MEETINGS = 5;

// --- 速率限制器 ---
class RateLimiter {
    constructor(limit, windowMs) {
        this.requests = new Map(); 
        this.limit = limit;
        this.windowMs = windowMs;
    }
    check(ip) {
        const now = Date.now();
        const record = this.requests.get(ip);
        if (!record) { this.requests.set(ip, { count: 1, startTime: now }); return true; }
        if (now - record.startTime > this.windowMs) { this.requests.set(ip, { count: 1, startTime: now }); return true; }
        if (record.count >= this.limit) return false;
        record.count++;
        return true;
    }
}
const loginLimiter = new RateLimiter(5, 60 * 1000); 
const createLimiter = new RateLimiter(10, 60 * 1000);

// --- 資料結構 ---
const meetings = new Map();

// --- 預設樣板 ---
let globalPresets = [
    { name: "⭕ 是非題", question: "您是否同意此提案？", options: ["⭕ 同意", "❌ 不同意"] },
    { name: "📊 評分題", question: "請對本次活動進行評分", options: ["⭐️⭐️⭐️⭐️⭐️ 非常滿意", "⭐️⭐️⭐️⭐️ 滿意", "⭐️⭐️⭐️ 普通", "⭐️⭐️ 尚可", "⭐️ 待加強"] },
    { name: "🍱 午餐題", question: "今天午餐想吃什麼類別？", options: ["🍱 便當/自助餐", "🍜 麵食/水餃", "🍔 速食", "🥗 輕食/沙拉"] }
];

// --- 輔助函式 ---
function isValidString(str, maxLength = 100) {
    return typeof str === 'string' && str.trim().length > 0 && str.length <= maxLength;
}

function createMeetingState(pin, hostName) {
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
        createdAt: Date.now(),
        lastActiveTime: Date.now(),
        timeoutDuration: DEFAULT_TIMEOUT 
    };
}

function generateUniquePin() {
    let pin;
    do { pin = Math.floor(1000 + Math.random() * 9000).toString(); } while (meetings.has(pin));
    return pin;
}

function touchMeeting(meeting) { if (meeting) meeting.lastActiveTime = Date.now(); }

// --- 自動清理 ---
setInterval(() => {
    const now = Date.now();
    meetings.forEach((meeting, pin) => {
        if (meeting.status !== 'terminated') {
            if (now - meeting.lastActiveTime > meeting.timeoutDuration) {
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
    const participantList = []; 

    meeting.voterRecords.forEach((data, deviceId) => {
        if (data.isOnline) {
            participantList.push({ 
                name: data.username, 
                joinTime: data.firstJoinTime
            });
        }

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
    
    participantList.sort((a, b) => a.joinTime - b.joinTime);

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
        meetingName: meeting.hostName, 
        settings: meeting.settings,
        timeLeft: meeting.endTime ? Math.max(0, Math.round((meeting.endTime - Date.now())/1000)) : 0,
        voteId: meeting.voteId
    };

    io.to(hostRoomName).emit('state-update', { 
        ...basePayload, options: fullOptions, hostVoterMap, presets: meeting.presets, participantList: participantList 
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
    
    const now = Date.now();
    meeting.voterRecords.forEach(record => {
        if (record.isOnline) {
            record.isOnline = false;
            record.lastLeaveTime = now;
        }
    });

    broadcastState(meeting);
    if (reason === 'auto-timeout') {
        io.to(`${meeting.pin}-host`).emit('force-terminated', '系統閒置過久自動關閉');
        io.to(`meeting-${meeting.pin}`).emit('force-terminated', '系統閒置過久自動關閉');
    }
    setTimeout(() => {
        meetings.delete(meeting.pin);
        broadcastAdminList();
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
    io.to('admin-room').emit('admin-data-update', {
        list: list,
        config: { maxMeetings: MAX_MEETINGS }
    });
}

// --- Socket 連線 ---
io.on('connection', (socket) => {
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    socket.on('join', (data) => {
        if (!data || !data.pin || !data.username) return;
        const pin = String(data.pin).substring(0, 4); 
        const username = String(data.username).substring(0, 20);
        const meeting = meetings.get(pin);

        if (!meeting) { socket.emit('joined', { success: false, error: 'PIN 碼無效' }); return; }
        if (meeting.status === 'terminated') { socket.emit('joined', { success: false, error: '會議已結束' }); return; }

        socket.join(`meeting-${pin}`);
        socket.data.pin = pin;
        socket.data.username = username;
        socket.data.deviceId = data.deviceId; 
        touchMeeting(meeting);

        const now = Date.now();
        
        if (!meeting.voterRecords.has(data.deviceId)) {
            meeting.voterRecords.set(data.deviceId, { 
                username: username, 
                votes: [], 
                firstJoinTime: now,
                lastLeaveTime: null,
                isOnline: true
            });
        } else {
            const record = meeting.voterRecords.get(data.deviceId);
            record.username = username;
            record.isOnline = true;
            record.lastLeaveTime = null; 
            meeting.voterRecords.set(data.deviceId, record);
        }
        
        socket.emit('joined', { success: true });
        if (data.deviceId && meeting.status === 'voting') {
            const record = meeting.voterRecords.get(data.deviceId);
            if (record) socket.emit('vote-confirmed', record.votes);
        }
        broadcastState(meeting);
        broadcastAdminList();
    });

    socket.on('create-meeting', (hostName) => {
        if (!createLimiter.check(clientIp)) return; 
        
        let activeCount = 0;
        meetings.forEach(m => { if (m.status !== 'terminated') activeCount++; });
        if (activeCount >= MAX_MEETINGS) {
            socket.emit('create-failed', '⚠️ 系統會議室數量已達上限，暫時無法建立新會議。');
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

    socket.on('host-resume', (pin) => {
        const meeting = meetings.get(pin);
        if (meeting && meeting.status !== 'terminated') {
            socket.data.pin = pin;
            socket.data.isHost = true;
            socket.join(`meeting-${pin}`);
            socket.join(`${pin}-host`);
            touchMeeting(meeting);
            socket.emit('host-resume-success', { pin: pin, hostName: meeting.hostName, history: meeting.history });
            broadcastState(meeting);
        } else {
            socket.emit('host-resume-fail');
        }
    });

    socket.on('start-vote', (data) => {
        const meeting = meetings.get(socket.data.pin);
        if (!meeting || !socket.data.isHost) return;
        touchMeeting(meeting);
        if (!Array.isArray(data.options) || data.options.length < 2) return;

        archiveCurrentVote(meeting);
        meeting.voterRecords.forEach(record => record.votes = []);
        meeting.options.forEach(o => o.count = 0);
        
        meeting.status = 'voting';
        meeting.question = String(data.question).substring(0, 200);
        meeting.settings.allowMulti = !!data.allowMulti;
        meeting.settings.blindMode = !!data.blindMode;
        meeting.voteId = Date.now(); 
        meeting.hasArchived = false;
        
        meeting.options = data.options.map((opt, index) => ({
            id: index, text: String(opt.text).substring(0, 100), color: opt.color, count: 0
        }));

        if (data.duration > 0) {
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
        if (meeting && socket.data.isHost) terminateMeeting(meeting);
    });

    socket.on('submit-vote', (data) => {
        const pin = socket.data.pin || data.pin; 
        const meeting = meetings.get(pin);
        if (!meeting || meeting.status !== 'voting') return;
        if (socket.data.isHost) return;
        touchMeeting(meeting);
        
        const safeVotes = Array.isArray(data.votes) ? data.votes.filter(v => Number.isInteger(v)) : [];
        if (meeting.voterRecords.has(data.deviceId)) {
            const record = meeting.voterRecords.get(data.deviceId);
            record.votes = safeVotes;
            record.username = String(data.username).substring(0, 20);
            meeting.voterRecords.set(data.deviceId, record);
        }
        broadcastState(meeting);
        socket.emit('vote-confirmed', safeVotes);
    });

    socket.on('request-export', () => {
        const meeting = meetings.get(socket.data.pin);
        if (!meeting || !socket.data.isHost) return;
        touchMeeting(meeting);
        
        let csvContent = `\uFEFF"會議名稱","${meeting.hostName.replace(/"/g, '""')}"\n`;
        csvContent += `"PIN 碼","${meeting.pin}"\n`;
        csvContent += `"匯出時間","${new Date().toLocaleString()}"\n\n`;

        csvContent += `--- 投票歷史紀錄 ---\n`;
        csvContent += `"題目","選項","票數","投票者名單"\n`; 
        meeting.history.forEach(record => {
            record.options.forEach(opt => {
                const voters = [];
                for (const [name, choices] of Object.entries(record.voterDetails)) { if (choices.includes(opt.id)) voters.push(name); }
                const safeQ = record.question.replace(/"/g, '""');
                const safeOpt = opt.text.replace(/"/g, '""');
                csvContent += `"${safeQ}","${safeOpt}",${opt.count},"${voters.join('; ')}"\n`;
            });
            csvContent += `,,,\n`; 
        });

        csvContent += `\n--- 人員考勤表 (同一裝置彙整) ---\n`;
        csvContent += `"姓名","最早進入時間","最後離開時間","目前狀態"\n`;
        
        meeting.voterRecords.forEach(record => {
            const firstIn = record.firstJoinTime ? new Date(record.firstJoinTime).toLocaleString() : '-';
            const lastOut = record.isOnline ? '-' : (record.lastLeaveTime ? new Date(record.lastLeaveTime).toLocaleString() : '-');
            const status = record.isOnline ? '🟢 在線' : '🔴 離線';
            
            csvContent += `"${record.username}","${firstIn}","${lastOut}","${status}"\n`;
        });
        
        socket.emit('export-data', csvContent);
    });

    socket.on('admin-login', (pwd) => {
        if (!loginLimiter.check(clientIp)) { socket.emit('admin-login-fail'); return; }
        if (pwd === ADMIN_PASSWORD) {
            socket.join('admin-room');
            socket.emit('admin-login-success');
            broadcastAdminList();
        } else {
            socket.emit('admin-login-fail');
        }
    });

    socket.on('admin-set-limit', (newLimit) => {
        if (socket.rooms.has('admin-room')) {
            const limit = parseInt(newLimit);
            if (limit > 0 && limit <= 100) {
                MAX_MEETINGS = limit;
                broadcastAdminList();
                socket.emit('admin-msg', `上限已更新為 ${MAX_MEETINGS}`);
            }
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
                const hours = Math.max(0.5, Math.min(parseInt(data.hours), 24));
                meeting.timeoutDuration = hours * 60 * 60 * 1000;
                broadcastAdminList();
            }
        }
    });

    socket.on('admin-change-password', (newPwd) => {
        if (socket.rooms.has('admin-room')) socket.emit('admin-msg', '基於安全考量，請透過修改 Render 環境變數 (ADMIN_PASSWORD) 來變更密碼');
    });

    socket.on('admin-add-preset', (preset) => {
        if (socket.rooms.has('admin-room')) {
            if(preset.name && preset.question && Array.isArray(preset.options)) {
                globalPresets.push(preset);
                meetings.forEach(m => { m.presets.push(preset); broadcastState(m); });
                socket.emit('admin-msg', '全域模板已新增');
            }
        }
    });

    socket.on('disconnect', () => {
        const pin = socket.data.pin;
        if (pin) {
            const meeting = meetings.get(pin);
            if (meeting) {
                if (socket.data.deviceId && meeting.voterRecords.has(socket.data.deviceId)) {
                    const record = meeting.voterRecords.get(socket.data.deviceId);
                    record.isOnline = false;
                    record.lastLeaveTime = Date.now();
                }
                setTimeout(() => broadcastState(meeting), 1000);
            }
        }
        broadcastAdminList();
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
