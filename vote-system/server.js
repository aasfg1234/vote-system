const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

// --- 新增：會議歷史紀錄 ---
let meetingHistory = []; 

// Key: username, Value: [optionId...]
const voterRecords = new Map();

// --- 歸檔功能：將當前題目存入歷史 ---
function archiveCurrentVote() {
    // 如果沒有題目或沒人投票，就不存
    if (!meetingState.question) return;

    // 建立這一題的完整快照
    const snapshot = {
        question: meetingState.question,
        options: JSON.parse(JSON.stringify(meetingState.options)), // 深拷貝選項狀態
        timestamp: new Date().toISOString(),
        totalVotes: 0,
        // 將 Map 轉為一般物件儲存，方便 CSV 讀取 { "小明": [0, 1] }
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

    // 1. 統計票數 & 建立主持人專用的名單視圖
    // hostVoterMap 格式: { optionId: ['小明', '小華'] }
    const hostVoterMap = {}; 

    voterRecords.forEach((votes, username) => {
        if (votes && votes.length > 0) {
            totalVotes++;
            votes.forEach(optId => {
                const opt = meetingState.options.find(o => o.id === optId);
                if (opt) {
                    opt.count++;
                    // 紀錄誰投了這個選項 (給主持人看)
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
    // 1. 給主持人：看到完整數據 + 誰投了誰 + 歷史紀錄
    io.to('host-room').emit('state-update', { 
        ...basePayload, 
        options: fullOptions,
        hostVoterMap: hostVoterMap, // 秘密資料
        history: meetingHistory     // 歷史資料
    });

    // 2. 給與會者：根據盲測設定
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
            broadcast
