const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- 設定 ---
const HOST_PASSWORD = process.env.HOST_PASSWORD || '8888';
app.use(express.static(path.join(__dirname, 'public')));

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

// --- 會議歷史紀錄 ---
let meetingHistory = []; 

// Key: username, Value: [optionId...]
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

// --- 廣播狀態 ---
function broadcastState() {
    let totalVotes = 0;
    meetingState.options.forEach(opt => opt.count = 0);

    // 建立主持人專用的名單視圖
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

    const room = io.sockets.adapter.rooms.get('meeting-room');
    const joinedCount = room ? room.size : 0;

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
        joinedCount: joinedCount,
        settings: meetingState.settings,
        timeLeft: meetingState.endTime ? Math.max(0, Math.round((meetingState.endTime - Date.now())/1000)) : 0,
        voteId: meetingState.voteId
    };

    // 分流廣播
    io.to('host-room').emit('state-update', { 
        ...basePayload, 
        options: fullOptions,
        hostVoterMap: hostVoterMap, 
        history: meetingHistory     
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

        if (pin === meetingState.pin) {
            socket.join('meeting-room');
            socket.emit('joined', { success: true });
            if (username && meetingState.status === 'voting') {
                const previousVotes = voterRecords.get(username);
                if (previousVotes) socket.emit('vote-confirmed', previousVotes);
            }
            broadcastState();
        } else {
            socket.emit('joined', { success: false, error: 'PIN 碼錯誤' });
        }
    });

    socket.on('host-login', (inputPassword) => {
        if (inputPassword === HOST_PASSWORD) {
            socket.join('host-room'); 
            socket.emit('host-login-success', { pin: meetingState.pin });
            socket.join('meeting-room');
            broadcastState(); 
        } else {
            socket.emit('host-login-fail');
        }
    });

    socket.on('start-vote', (data) => {
        if (meetingState.question && meetingState.status !== 'waiting') {
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

    socket.on('submit-vote', (data) => {
        if (meetingState.status !== 'voting') return;
        const votes = data.votes;
        const username = data.username;
        if (!username) return; 
        voterRecords.set(username, Array.isArray(votes) ? votes : [votes]);
        broadcastState();
        socket.emit('vote-confirmed', votes);
    });

    socket.on('request-export', () => {
        let csvContent = "\uFEFF題目,選項,票數,投票者名單\n"; 

        // 歷史題目
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

        // 當前題目
        if (meetingState.question) {
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

}); // <--- 確保這行存在！

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
