const { io } = require('socket.io-client');

console.log('Connecting to Socket.IO at http://localhost:4000/live-queue...');
const socket = io('http://localhost:4000/live-queue', {
    transports: ['websocket', 'polling'],
    reconnection: false
});

socket.on('connect', () => {
    console.log('CONNECTED successfully! ID:', socket.id);
    
    // Subscribe to date room
    const payload = {
        appointment_date: new Date().toISOString().split('T')[0]
    };
    console.log('Sending live-queue.subscribe with payload:', payload);
    socket.emit('live-queue.subscribe', payload, (ack) => {
        console.log('SUBSCRIBE ACK RECEIVED:', ack);
        process.exit(0);
    });
});

socket.on('connect_error', (err) => {
    console.error('CONNECTION ERROR:', err.message);
    process.exit(1);
});

socket.on('disconnect', (reason) => {
    console.log('DISCONNECTED:', reason);
});

// Set a timeout to prevent hanging
setTimeout(() => {
    console.log('Timeout reached. Exiting.');
    process.exit(1);
}, 5000);
