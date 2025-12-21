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
    endTime: null
};

// 重點修改：改用 deviceId 來存票，而不是 socket.id
// Key: deviceId (String), Value: [optionId1, optionId2...]
const deviceVotes = new Map();

// --- 廣播狀態 ---
function broadcastState() {
    // 計算總票數 (根據 deviceVotes 的大小)
    let totalVotes = 0;
    // 歸零選項計數
    meetingState.options.forEach(opt => opt.count = 0);

    // 重新統計所有裝置的投票
    deviceVotes.forEach((votes) => {
        if (votes && votes.length > 0) {
            totalVotes++; // 有效投票的裝置數
            votes.forEach(optId => {
                const opt = meetingState.options.find(o => o.id === optId);
                if (opt) opt.count++;
            });
        }
    });

    // 計算加入人數
    const room = io.sockets.adapter.rooms.get('meeting-room');
    const joinedCount = room ? room.size : 0;

    // 1. 完整數據
    const fullOptions = meetingState.options.map(opt => ({
        id: opt.id,
        text: opt.text,
        color: opt.color,
        count: opt.count,
        percent: totalVotes === 0 ? 0 : Math.round((opt.count / totalVotes) * 100)
    }));

    // 2. 遮蔽數據
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
        timeLeft: meetingState.endTime ? Math.max(0, Math.round((meetingState.endTime - Date.now())/1000)) : 0
    };

    if (meetingState.settings.blindMode && meetingState.status === 'voting') {
        io.to('host-room').emit('state-update', { ...basePayload, options: fullOptions });
        io.except('host-room').emit('state-update', { ...basePayload, options: blindedOptions });
    } else {
        io.emit('state-update', { ...basePayload, options: fullOptions });
    }
}

function resetVotes() {
    deviceVotes.clear(); // 清空裝置投票紀錄
    meetingState.options.forEach(opt => opt.count = 0);
}

// --- Socket 連線 ---
io.on('connection', (socket) => {
    
    // 1. 加入會議 (接收 pin 和 deviceId)
    socket.on('join', (data) => {
        // 相容性處理：data 可能是物件 {pin, deviceId} 或純字串 pin
        const pin = typeof data === 'object' ? data.pin : data;
        const deviceId = typeof data === 'object' ? data.deviceId : null;

        if (pin === meetingState.pin) {
            socket.join('meeting-room');
            socket.emit('joined', { success: true });

            // 重點：如果這個裝置之前投過票，把票還給他 (解決重新整理後選項消失的問題)
            if (deviceId && meetingState.status === 'voting') {
                const previousVotes = deviceVotes.get(deviceId);
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

    // 5. 提交投票 (接收 votes 和 deviceId)
    socket.on('submit-vote', (data) => {
        if (meetingState.status !== 'voting') return;

        const votes = data.votes;
        const deviceId = data.deviceId;

        if (!deviceId) return; // 沒有 ID 不給投

        // 直接用 deviceId 覆蓋舊的投票 (一個人只能有一筆紀錄)
        deviceVotes.set(deviceId, Array.isArray(votes) ? votes : [votes]);
        
        broadcastState();
        socket.emit('vote-confirmed', votes);
    });

    // 6. 匯出 CSV
    socket.on('request-export', () => {
        // CSV 邏輯 (選項計數已在 broadcastState 計算過，直接用 meetingState.options)
        // 為了確保準確，重新跑一次計算邏輯
        const totalVotes = Array.from(deviceVotes.values()).filter(v => v.length > 0).length;
        
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
