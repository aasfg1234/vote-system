const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- 系統狀態 ---
let meetingState = {
    pin: Math.floor(1000 + Math.random() * 9000).toString(),
    status: 'waiting', // waiting, voting, ended
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

const userVotes = new Map();

// --- 廣播狀態 ---
function broadcastState() {
    const totalVotes = userVotes.size;

    // 計算目前連線人數 (加入人數)
    const room = io.sockets.adapter.rooms.get('meeting-room');
    const joinedCount = room ? room.size : 0;

    // 1. 完整數據 (給主持人 & 結束後所有人)
    const fullOptions = meetingState.options.map(opt => ({
        id: opt.id,
        text: opt.text,
        color: opt.color,
        count: opt.count,
        percent: totalVotes === 0 ? 0 : Math.round((opt.count / totalVotes) * 100)
    }));

    // 2. 遮蔽數據 (給盲測時的與會者)
    const blindedOptions = meetingState.options.map(opt => ({
        id: opt.id,
        text: opt.text,
        color: opt.color,
        count: -1,   // 隱藏標記
        percent: -1  // 隱藏標記
    }));

    const basePayload = {
        status: meetingState.status,
        question: meetingState.question,
        totalVotes: totalVotes,
        joinedCount: joinedCount, // 傳送加入人數
        settings: meetingState.settings,
        timeLeft: meetingState.endTime ? Math.max(0, Math.round((meetingState.endTime - Date.now())/1000)) : 0
    };

    if (meetingState.settings.blindMode && meetingState.status === 'voting') {
        // A. 盲測進行中：分流發送
        io.to('host-room').emit('state-update', { ...basePayload, options: fullOptions });
        io.except('host-room').emit('state-update', { ...basePayload, options: blindedOptions });
    } else {
        // B. 一般情況：所有人看到全部
        io.emit('state-update', { ...basePayload, options: fullOptions });
    }
}

function resetVotes() {
    userVotes.clear();
    meetingState.options.forEach(opt => opt.count = 0);
}

// --- Socket 連線邏輯 ---
io.on('connection', (socket) => {
    
    // 1. 加入會議
    socket.on('join', (pin) => {
        if (pin === meetingState.pin) {
            socket.join('meeting-room');
            socket.emit('joined', { success: true });
            broadcastState();
        } else {
            socket.emit('joined', { success: false, error: 'PIN 碼錯誤' });
        }
    });

    // 2. 主持人登入
    socket.on('host-login', () => {
        socket.join('host-room'); 
        socket.emit('host-data', { pin: meetingState.pin });
        broadcastState(); 
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
    socket.on('stop-vote', () => {
        stopVoting();
    });

    function stopVoting() {
        if (meetingState.timer) clearInterval(meetingState.timer);
        meetingState.status = 'ended';
        meetingState.endTime = null;
        broadcastState();
    }

    // 5. 投票與改票
    socket.on('submit-vote', (selectedOptionIds) => {
        if (meetingState.status !== 'voting') return;

        const previousVotes = userVotes.get(socket.id);
        if (previousVotes) {
            previousVotes.forEach(optId => {
                const opt = meetingState.options.find(o => o.id === optId);
                if (opt && opt.count > 0) opt.count--;
            });
        }

        const newVotes = Array.isArray(selectedOptionIds) ? selectedOptionIds : [selectedOptionIds];
        userVotes.set(socket.id, newVotes);
        
        newVotes.forEach(optId => {
            const opt = meetingState.options.find(o => o.id === optId);
            if (opt) opt.count++;
        });

        broadcastState();
        socket.emit('vote-confirmed', newVotes);
    });

    // 6. 匯出 CSV
    socket.on('request-export', () => {
        const headers = "\uFEFF題目,選項,票數,百分比\n"; 
        const totalVotes = userVotes.size;
        
        const rows = meetingState.options.map(opt => {
            const percent = totalVotes === 0 ? 0 : Math.round((opt.count / totalVotes) * 100);
            const safeQuestion = meetingState.question.replace(/"/g, '""');
            const safeText = opt.text.replace(/"/g, '""');
            return `"${safeQuestion}","${safeText}",${opt.count},${percent}%`;
        }).join("\n");
        
        socket.emit('export-data', headers + rows);
    });

    // 7. 斷線處理 (更新人數)
    socket.on('disconnect', () => {
        broadcastState();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

