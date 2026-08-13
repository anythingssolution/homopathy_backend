require('dotenv').config();

const cors = require('cors');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const sqlPanelRoutes = require('./routes/sqlPanelRoutes');
const { env } = require('./config/env');
const v1Routes = require('./routes/v1');
const { testConnection, query } = require('./config/db');
const { normalizeRole, normalizeRoleCode } = require('./utils/roles');
const { setIO, setLiveQueueNsp, setPublicStatusNsp } = require('./utils/realtime');
const { buildLiveQueueRoom, buildLiveQueueDateRoom, isValidDateString, toPositiveInt } = require('./services/liveQueueService');
const { getDoctorSessionStatus } = require('./services/doctorSessionService');
const { startPendingFollowUpNotifier } = require('./services/followupService');
const { startLiveQueueDueJobWorker } = require('./services/liveQueueAutomationService');
const { loadBranchLayoutsIntoCache } = require('./utils/appointmentTokens');
const {
    notFound,
    globalErrorHandler,
} = require('./middleware/errorMiddleware');

const app = express();
const PORT = env.port;
const server = http.createServer(app);

const { Server } = require('socket.io');
const io = new Server(server, {
    cors: {
        origin: env.corsOrigin,
        methods: ['GET', 'POST', 'PATCH'],
    },
});

setIO(io);

io.use(async (socket, next) => {
    try {
        const token =
            socket.handshake.auth?.token ||
            (socket.handshake.headers.authorization || '').replace(/^Bearer\s+/i, '');

        if (!token) {
            return next(new Error('Socket auth token is missing'));
        }

        const decoded = jwt.verify(token, env.jwtSecret);
        const users = await query(
            `SELECT u.id, u.uuid, u.mobile_no, u.role AS role_code, u.is_active, u.selected_branch_id
             FROM master_users u
             WHERE u.id = ?
             LIMIT 1`,
            [decoded.id]
        );

        if (users.length === 0 || !users[0].is_active) {
            return next(new Error('Socket user not found or inactive'));
        }

        socket.user = {
            id: users[0].id,
            uuid: users[0].uuid,
            mobile_no: users[0].mobile_no,
            role: normalizeRole(users[0].role_code),
            role_code: normalizeRoleCode(users[0].role_code),
            selected_branch_id: users[0].selected_branch_id ? Number(users[0].selected_branch_id) : null,
        };

        return next();
    } catch (error) {
        return next(new Error('Invalid socket token'));
    }
});

const buildDoctorSessionSocketPayload = (status) => ({
    is_doctor_available: status?.is_doctor_available || false,
    is_on_break: status?.is_on_break || false,
    has_open_session: status?.has_open_session || false,
    status: status?.status || 'OUT',
    label: status?.label || 'Doctor Out',
    time: status?.time || null,
    started_at: status?.started_at || null,
    break_started_at: status?.break_started_at || null,
    ended_at: status?.ended_at || null,
    doctor_name: status?.doctor_name || null,
    branch_name: status?.branch_name || null,
    doctor_id: status?.doctor_id || null,
    branch_id: status?.branch_id || null,
    slot_id: status?.slot_id || null,
    session_id: status?.session_id || null,
    source: status?.source || 'MANUAL',
    updated_at: status?.updated_at || null,
});

const emitInitialDoctorSessionStatus = async (socket, {
    doctorId = null,
    branchId = null,
} = {}) => {
    try {
        const status = await getDoctorSessionStatus({ doctorId, branchId });
        const payload = buildDoctorSessionSocketPayload(status);

        socket.emit('doctor.session.current', payload);
        socket.emit('doctor.session.updated', payload);
    } catch (error) {
        const fallbackPayload = buildDoctorSessionSocketPayload(null);
        socket.emit('doctor.session.current', fallbackPayload);
        socket.emit('doctor.session.updated', fallbackPayload);
    }
};

const buildLiveQueueSubscriptionRooms = ({ branchId = null, slotId = null, appointmentDate }) => {
    const rooms = new Set();

    if (branchId && slotId) {
        rooms.add(buildLiveQueueRoom({ branchId, slotId, appointmentDate }));
    }

    if (branchId) {
        rooms.add(buildLiveQueueDateRoom({ branchId, appointmentDate }));
    }

    rooms.add(buildLiveQueueDateRoom({ appointmentDate }));

    return [...rooms];
};

io.on('connection', (socket) => {
    if (socket.user?.id) {
        socket.join(`user:${socket.user.id}`);
    }

    if (socket.user?.role_code) {
        socket.join(`role:${socket.user.role_code}`);
    }

    socket.emit('socket.connected', {
        success: true,
        user_id: socket.user?.id || null,
        role: socket.user?.role || null,
        role_code: socket.user?.role_code || null,
    });

    void emitInitialDoctorSessionStatus(socket, {
        doctorId: socket.user?.role_code === 'DOC' ? socket.user.id : null,
        branchId: socket.user?.selected_branch_id || null,
    });

    socket.on('live-queue.subscribe', (payload = {}, ack) => {
        try {
            const branchId = toPositiveInt(payload.branch_id);
            const slotId = toPositiveInt(payload.slot_id);
            const appointmentDate = String(payload.appointment_date || '').trim();

            if (!isValidDateString(appointmentDate)) {
                throw new Error('appointment_date is required');
            }

            const roomNames = buildLiveQueueSubscriptionRooms({ branchId, slotId, appointmentDate });
            roomNames.forEach((roomName) => socket.join(roomName));

            if (typeof ack === 'function') {
                ack({
                    success: true,
                    room: roomNames[0],
                    rooms: roomNames,
                });
            }
        } catch (error) {
            if (typeof ack === 'function') {
                ack({
                    success: false,
                    message: error.message || 'Unable to subscribe live queue',
                });
            }
        }
    });

    socket.on('live-queue.unsubscribe', (payload = {}, ack) => {
        try {
            const branchId = toPositiveInt(payload.branch_id);
            const slotId = toPositiveInt(payload.slot_id);
            const appointmentDate = String(payload.appointment_date || '').trim();

            if (!isValidDateString(appointmentDate)) {
                throw new Error('appointment_date is required');
            }

            const roomNames = buildLiveQueueSubscriptionRooms({ branchId, slotId, appointmentDate });
            roomNames.forEach((roomName) => socket.leave(roomName));

            if (typeof ack === 'function') {
                ack({
                    success: true,
                    room: roomNames[0],
                    rooms: roomNames,
                });
            }
        } catch (error) {
            if (typeof ack === 'function') {
                ack({
                    success: false,
                    message: error.message || 'Unable to unsubscribe live queue',
                });
            }
        }
    });
});

// ── PUBLIC /live-queue namespace ──────────────────────────────────────────────
// No JWT required — designed for TV displays, kiosks, and public screens.
// Only live-queue subscribe/unsubscribe are allowed; no user/role rooms.
const liveQueueNsp = io.of('/live-queue');
setLiveQueueNsp(liveQueueNsp);

liveQueueNsp.on('connection', (socket) => {
    console.log('Public live-queue socket connected:', socket.id);

    socket.emit('socket.connected', {
        success: true,
        guest: true,
    });

    socket.on('live-queue.subscribe', (payload = {}, ack) => {
        try {
            const branchId = toPositiveInt(payload.branch_id);
            const slotId = toPositiveInt(payload.slot_id);
            const appointmentDate = String(payload.appointment_date || '').trim();

            if (!isValidDateString(appointmentDate)) {
                throw new Error('appointment_date is required');
            }

            const roomNames = buildLiveQueueSubscriptionRooms({ branchId, slotId, appointmentDate });
            roomNames.forEach((roomName) => socket.join(roomName));
            console.log(`Guest socket ${socket.id} joined rooms: ${roomNames.join(', ')}`);

            if (branchId) {
                void emitInitialDoctorSessionStatus(socket, { branchId });
            }

            if (typeof ack === 'function') {
                ack({ success: true, room: roomNames[0], rooms: roomNames });
            }
        } catch (error) {
            console.error(`Guest subscribe error: ${error.message}`);
            if (typeof ack === 'function') {
                ack({ success: false, message: error.message || 'Unable to subscribe live queue' });
            }
        }
    });

    socket.on('live-queue.unsubscribe', (payload = {}, ack) => {
        try {
            const branchId = toPositiveInt(payload.branch_id);
            const slotId = toPositiveInt(payload.slot_id);
            const appointmentDate = String(payload.appointment_date || '').trim();

            if (!isValidDateString(appointmentDate)) {
                throw new Error('appointment_date is required');
            }

            const roomNames = buildLiveQueueSubscriptionRooms({ branchId, slotId, appointmentDate });
            roomNames.forEach((roomName) => socket.leave(roomName));

            if (typeof ack === 'function') {
                ack({ success: true, room: roomNames[0], rooms: roomNames });
            }
        } catch (error) {
            if (typeof ack === 'function') {
                ack({ success: false, message: error.message || 'Unable to unsubscribe live queue' });
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('Public live-queue socket disconnected:', socket.id);
    });
});

const publicStatusNsp = io.of('/public-status');
setPublicStatusNsp(publicStatusNsp);

publicStatusNsp.on('connection', async (socket) => {
    const doctorId = toPositiveInt(socket.handshake.query?.doctor_id);
    const branchId = toPositiveInt(socket.handshake.query?.branch_id);
    await emitInitialDoctorSessionStatus(socket, { doctorId, branchId });
});

app.use(cors({
    origin: env.corsOrigin,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (_req, res) => {
    res.status(200).json({
        success: true,
        message: 'Server is running',
        health_check: '/api/health',
        api_base: '/api/v1',
    });
});

app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
});

app.get('/api/health', (_req, res) => {
    res.status(200).json({
        success: true,
        message: 'Server is running',
    });
});

app.get('/api/v1/health', (_req, res) => {
    res.status(200).json({
        success: true,
        message: 'Server is running',
        version: 'v1',
    });
});

app.use('/sql-panel', sqlPanelRoutes);
app.use('/api/v1', v1Routes);

// Backward-compatible base URL; points to current v1 implementation.
app.use('/api', v1Routes);

app.use(notFound);
app.use(globalErrorHandler);

const startServer = async () => {
    try {
        await testConnection();
        await loadBranchLayoutsIntoCache();
        startPendingFollowUpNotifier();
        startLiveQueueDueJobWorker();
        if (env.nodeEnv === 'production' && env.otp.useDefaultInProduction) {
            console.warn('[startup] WARNING: Production default OTP mode is enabled');
        }
        server.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    } catch (error) {
        console.error('Database connection failed:', error.message);
        process.exit(1);
    }
};

startServer();
