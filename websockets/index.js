const WebSocket = require('ws');

let clients = [];

const startWebSocketServer = (server) => {
    const wss = new WebSocket.Server({ server });

    wss.on('connection', (ws) => {
        clients.push(ws);
        console.log('WebSocket 클라이언트 연결됨');

        ws.on('message', (message) => {
            console.log('받은 메시지:', message);
            clients.forEach(client => client.send(`서버에서 받은 메시지: ${message}`));
        });

        ws.on('close', () => {
            clients = clients.filter(client => client !== ws);
            console.log('클라이언트 연결 종료');
        });
    });
};

module.exports = { startWebSocketServer };