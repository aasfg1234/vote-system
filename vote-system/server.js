const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- 設定 ---
let hostPassword = process.env.HOST_PASSWORD || '8888';
let hostName = 'HOST';

app.use(express.static(path.join(__dirname, 'public')));

// --- 預設樣板 ---
let presets = [
    { name: "⭕ 是非題", question: "您是否同意此提案？", options: ["⭕ 同意", "❌ 不同意"] },
    { name: "📊 評分題", question: "請對本次活動進行評分", options: ["⭐️⭐️⭐️⭐️⭐️ 非常滿意", "⭐️⭐️⭐️⭐️ 滿意", "⭐️⭐️⭐️ 普通", "⭐️⭐️ 尚可", "⭐️ 待加強"] },
    { name: "🍱 午餐題", question: "今天午餐想吃什麼類別？", options: ["🍱 便當/自助餐", "🍜 麵食/水餃", "🍔 速食", "🥗 輕食/沙拉"] }
];

// --- 系統狀態 ---
let meetingState = {
    pin: Math.floor(1000 + Math.random() * 9000).toString(),
    status: 'waiting', 
    question: '',
    options: [],
    settings: { allowMulti: false, blindMode: false, duration: 0 },
    timer: null,
    endTime: null,
    voteId: 0 
};

let meetingHistory = []; 
const voterRecords = new Map();

// --- 歸檔功能 ---
function archiveCurrentVote() {
    if (!meetingState.question) return;
    const snapshot = {
        question: meetingState.question,
        options: JSON.parse(JSON.stringify(meetingState.options)), 
        timestamp: new Date().toISOString(),
        totalVotes: 0,
        voterDetails: {} 
    };
    let total = 0;
    voterRecords.forEach((votes, username) => {
        if (votes && votes.length > 0) {
            total++;
            snapshot.voterDetails[username] = votes;
        }
    });
    snapshot.totalVotes = total;
    meetingHistory.push(snapshot);
}

// --- 廣播狀態 (關鍵修改：排除主持人人數) ---
function broadcastState() {
    let totalVotes = 0;
    meetingState.options.forEach(opt => opt.count = 0);

    const hostVoterMap = {}; 

    voterRecords.forEach((votes, username) => {
        if (votes && votes.length > 0) {
            totalVotes++;
            votes.forEach(optId => {
                const opt = meetingState.options.find(o => o.id === optId);
                if (opt) {
                    opt.count++;
                    if (!hostVoterMap[optId]) hostVoterMap[optId] = [];
                    hostVoterMap[optId].push(username);
                }
            });
        }
    });

    // --- 關鍵修改：計算真實與會者人數 ---
    const allSockets = io.sockets.adapter.rooms.get('meeting-room');
    const hostSockets = io.sockets.adapter.rooms.get('host-room');
    let realUserCount = 0;

    if (allSockets) {
        allSockets.forEach(socketId => {
            // 如果這個 Socket ID 不在主持人房間內，才算是一個與會者
            if (!hostSockets || !hostSockets.has(socketId)) {
                realUserCount++;
            }
        });
    }
    // ------------------------------------

    const fullOptions = meetingState.options.map(opt => ({
        id: opt.id,
        text: opt.text,
        color: opt.color,
        count: opt.count,
        percent: totalVotes === 0 ? 0 : Math.round((opt.count / totalVotes) * 100)
    }));

    const blindedOptions = meetingState.options.map(opt => ({
        id: opt.id,
        text: opt.text,
        color: opt.color,
        count: -1,
        percent: -1
    }));

    const basePayload = {
        status: meetingState.status,
        question: meetingState.question,
        totalVotes: totalVotes,
        joinedCount: realUserCount, // 使用過濾後的人數
        settings: meetingState.settings,
        timeLeft: meetingState.endTime ? Math.max(0, Math.round((meetingState.endTime - Date.now())/1000)) : 0,
        voteId: meetingState.voteId
    };

    io.to('host-room').emit('state-update', { 
        ...basePayload, 
        options: fullOptions,
        hostVoterMap: hostVoterMap, 
        history: meetingHistory,
        presets: presets 
    });

    if (meetingState.settings.blindMode && meetingState.status === 'voting') {
        io.except('host-room').emit('state-update', { ...basePayload, options: blindedOptions });
    } else {
        io.except('host-room').emit('state-update', { ...basePayload, options: fullOptions });
    }
}

function resetVotes() {
    voterRecords.clear();
    meetingState.options.forEach(opt => opt.count = 0);
}

// --- Socket 連線 ---
io.on('connection', (socket) => {
    
    socket.on('join', (data) => {
        const pin = typeof data === 'object' ? data.pin : data;
        const username = typeof data === 'object' ? data.username : null;

        if (meetingState.status === 'terminated' && username !== hostName) {
            socket.emit('joined', { success: false, error: '會議已結束' });
            return;
        }

        if (pin === meetingState.pin) {
            socket.join('meeting-room');
            socket.emit('joined', { success: true });
            
            // 如果是主持人重連，不需要恢復投票狀態
            if (username && username !== hostName && meetingState.status === 'voting') {
                const previousVotes = voterRecords.get(username);
                if (previousVotes) socket.emit('vote-confirmed', previousVotes);
            }
            broadcastState();
        } else {
            socket.emit('joined', { success: false, error: 'PIN 碼錯誤' });
        }
    });

    socket.on('host-login', (inputPassword) => {
        if (inputPassword === hostPassword) {
            if (meetingState.status === 'terminated') {
                io.in('meeting-room').disconnectSockets();
                meetingState = {
                    pin: Math.floor(1000 + Math.random() * 9000).toString(),
                    status: 'waiting', 
                    question: '',
                    options: [],
                    settings: { allowMulti: false, blindMode: false, duration: 0 },
                    timer: null,
                    endTime: null,
                    voteId: 0 
                };
                meetingHistory = [];
                voterRecords.clear();
            }

            socket.join('host-room'); 
            // 主持人也加入 meeting-room 以便接收廣播，但會在計數時被排除
            socket.join('meeting-room'); 
            
            socket.emit('host-login-success', { pin: meetingState.pin, hostName: hostName });
            broadcastState(); 
        } else {
            socket.emit('host-login-fail');
        }
    });

    socket.on('change-password', (newPwd) => {
        hostPassword = newPwd;
        socket.emit('password-updated');
    });

    socket.on('change-host-name', (newName) => {
        hostName = newName;
        socket.emit('host-name-updated', hostName);
    });

    socket.on('add-preset', (newPreset) => {
        presets.push(newPreset);
        broadcastState(); 
    });

    socket.on('start-vote', (data) => {
        if (meetingState.question && meetingState.status !== 'waiting' && meetingState.status !== 'terminated') {
            archiveCurrentVote();
        }
        resetVotes();
        meetingState.status = 'voting';
        meetingState.question = data.question;
        meetingState.settings.allowMulti = data.allowMulti;
        meetingState.settings.blindMode = data.blindMode;
        meetingState.voteId = Date.now(); 
        
        meetingState.options = data.options.map((opt, index) => ({
            id: index,
            text: opt.text,
            color: opt.color,
            count: 0
        }));

        if (data.duration > 0) {
            meetingState.endTime = Date.now() + (data.duration * 1000);
            if (meetingState.timer) clearInterval(meetingState.timer);
            meetingState.timer = setInterval(() => {
                const left = Math.round((meetingState.endTime - Date.now())/1000);
                if (left <= 0) stopVoting();
                else io.to('meeting-room').emit('timer-tick', left);
            }, 1000);
        } else {
            meetingState.endTime = null;
            if (meetingState.timer) clearInterval(meetingState.timer);
        }
        broadcastState();
    });

    socket.on('stop-vote', () => stopVoting());

    function stopVoting() {
        if (meetingState.timer) clearInterval(meetingState.timer);
        meetingState.status = 'ended';
        meetingState.endTime = null;
        broadcastState();
    }

    socket.on('terminate-meeting', () => {
        if (meetingState.question && meetingState.status !== 'waiting') {
            archiveCurrentVote();
        }
        if (meetingState.timer) clearInterval(meetingState.timer);
        meetingState.status = 'terminated';
        meetingState.question = '';
        meetingState.endTime = null;
        broadcastState();
    });

    // --- 關鍵修改：主持人不能投票 ---
    socket.on('submit-vote', (data) => {
        if (meetingState.status !== 'voting') return;
        const votes = data.votes;
        const username = data.username;
        
        // 安全檢查：如果是主持人，直接忽略
        // 判斷方式： socket 是否在 host-room 中
        if (socket.rooms.has('host-room')) {
            return;
        }

        if (!username) return; 
        voterRecords.set(username, Array.isArray(votes) ? votes : [votes]);
        broadcastState();
        socket.emit('vote-confirmed', votes);
    });

    socket.on('request-export', () => {
        let csvContent = "\uFEFF題目,選項,票數,投票者名單\n"; 
        meetingHistory.forEach(record => {
            record.options.forEach(opt => {
                const voters = [];
                for (const [name, choices] of Object.entries(record.voterDetails)) {
                    if (choices.includes(opt.id)) voters.push(name);
                }
                const safeQ = record.question.replace(/"/g, '""');
                const safeOpt = opt.text.replace(/"/g, '""');
                const safeVoters = voters.join('; ');
                csvContent += `"[歷史] ${safeQ}","${safeOpt}",${opt.count},"${safeVoters}"\n`;
            });
            csvContent += `,,,\n`; 
        });

        if (meetingState.question && meetingState.status !== 'terminated') {
            const currentVoterMap = {};
            voterRecords.forEach((votes, username) => {
                votes.forEach(optId => {
                    if(!currentVoterMap[optId]) currentVoterMap[optId] = [];
                    currentVoterMap[optId].push(username);
                });
            });
            meetingState.options.forEach(opt => {
                const voters = currentVoterMap[opt.id] || [];
                const safeQ = meetingState.question.replace(/"/g, '""');
                const safeOpt = opt.text.replace(/"/g, '""');
                const safeVoters = voters.join('; ');
                csvContent += `"[當前] ${safeQ}","${safeOpt}",${opt.count},"${safeVoters}"\n`;
            });
        }
        socket.emit('export-data', csvContent);
    });

    socket.on('disconnect', () => broadcastState());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
