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
    settings: {
        allowMulti: false,
        blindMode: false,
        duration: 0
    },
    timer: null,
    endTime: null,
    voteId: 0 
};

// 修改：改用 username (姓名) 作為 Key
// Key: username, Value: [optionId...]
const voterRecords = new Map();

// --- 廣播狀態 ---
function broadcastState() {
    let totalVotes = 0;
    meetingState.options.forEach(opt => opt.count = 0);

    // 統計票數
    voterRecords.forEach((votes) => {
        if (votes && votes.length > 0) {
            totalVotes++;
            votes.forEach(optId => {
                const opt = meetingState.options.find(o => o.id === optId);
                if (opt) opt.count++;
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

    if (meetingState.settings.blindMode && meetingState.status === 'voting') {
        io.to('host-room').emit('state-update', { ...basePayload, options: fullOptions });
        io.except('host-room').emit('state-update', { ...basePayload, options: blindedOptions });
    } else {
        io.emit('state-update', { ...basePayload, options: fullOptions });
    }
}

function resetVotes() {
    voterRecords.clear(); // 清空紀錄
    meetingState.options.forEach(opt => opt.count = 0);
}

// --- Socket 連線 ---
io.on('connection', (socket) => {
    
    // 1. 加入會議 (接收 pin 和 username)
    socket.on('join', (data) => {
        const pin = typeof data === 'object' ? data.pin : data;
        const username = typeof data === 'object' ? data.username : null; // 改收 username

        if (pin === meetingState.pin) {
            socket.join('meeting-room');
            socket.emit('joined', { success: true });

            // 如果這個名字已經投過票，恢復他的選擇 (跨瀏覽器也能恢復)
            if (username && meetingState.status === 'voting') {
                const previousVotes = voterRecords.get(username);
                if (previousVotes) {
                    socket.emit('vote-confirmed', previousVotes);
                }
            }
            broadcastState();
        } else {
            socket.emit('joined', { success: false, error: 'PIN 碼錯誤' });
        }
    });

    // 2. 主持人登入
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

    // 3. 開始投票
    socket.on('start-vote', (data) => {
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

    // 4. 結束投票
    socket.on('stop-vote', () => stopVoting());

    function stopVoting() {
        if (meetingState.timer) clearInterval(meetingState.timer);
        meetingState.status = 'ended';
        meetingState.endTime = null;
        broadcastState();
    }

    // 5. 提交投票 (接收 votes 和 username)
    socket.on('submit-vote', (data) => {
        if (meetingState.status !== 'voting') return;
        const votes = data.votes;
        const username = data.username;

        if (!username) return; 

        // 記錄該名字的投票
        voterRecords.set(username, Array.isArray(votes) ? votes : [votes]);
        
        broadcastState();
        socket.emit('vote-confirmed', votes);
    });

    // 6. 匯出 CSV
    socket.on('request-export', () => {
        const totalVotes = Array.from(voterRecords.values()).filter(v => v.length > 0).length;
        const headers = "\uFEFF題目,選項,票數,百分比\n"; 
        const rows = meetingState.options.map(opt => {
            const percent = totalVotes === 0 ? 0 : Math.round((opt.count / totalVotes) * 100);
            const safeQuestion = meetingState.question.replace(/"/g, '""');
            const safeText = opt.text.replace(/"/g, '""');
            return `"${safeQuestion}","${safeText}",${opt.count},${percent}%`;
        }).join("\n");
        socket.emit('export-data', headers + rows);
    });

    socket.on('disconnect', () => broadcastState());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
