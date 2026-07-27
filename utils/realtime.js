let ioInstance = null;
let liveQueueNsp = null;
let publicStatusNsp = null;

const setIO = (io) => {
    ioInstance = io;
};

const getIO = () => ioInstance;

const setLiveQueueNsp = (nsp) => {
    liveQueueNsp = nsp;
};

const getLiveQueueNsp = () => liveQueueNsp;

const setPublicStatusNsp = (nsp) => {
    publicStatusNsp = nsp;
};

const getPublicStatusNsp = () => publicStatusNsp;

const emitToRole = (role, eventName, payload) => {
    if (!ioInstance) {
        return;
    }

    ioInstance.to(`role:${role}`).emit(eventName, payload);
};

const emitToUser = (userId, eventName, payload) => {
    if (!ioInstance) {
        return;
    }

    ioInstance.to(`user:${userId}`).emit(eventName, payload);
};

const emitToRoom = (roomName, eventName, payload) => {
    if (!ioInstance || !roomName) {
        return;
    }

    ioInstance.to(roomName).emit(eventName, payload);
};

/**
 * Emit to a live-queue room on BOTH the default namespace (authenticated users)
 * and the /live-queue namespace (public/guest displays).
 */
const emitToLiveQueueRoom = (roomName, eventName, payload) => {
    if (!roomName) return;

    // Authenticated clients on default namespace
    if (ioInstance) {
        ioInstance.to(roomName).emit(eventName, payload);
    }

    // Guest/public clients on /live-queue namespace
    if (liveQueueNsp) {
        liveQueueNsp.to(roomName).emit(eventName, payload);
    }
};

const emitToPublicLiveQueueRoom = (roomName, eventName, payload) => {
    if (!roomName || !liveQueueNsp) {
        return;
    }

    liveQueueNsp.to(roomName).emit(eventName, payload);
};

const emitDoctorSessionUpdate = (payload) => {
    if (ioInstance) {
        ioInstance.emit('doctor.session.updated', payload);
    }

    if (publicStatusNsp) {
        publicStatusNsp.emit('doctor.session.updated', payload);
    }
};

module.exports = {
    setIO,
    getIO,
    setLiveQueueNsp,
    getLiveQueueNsp,
    setPublicStatusNsp,
    getPublicStatusNsp,
    emitToRole,
    emitToUser,
    emitToRoom,
    emitToLiveQueueRoom,
    emitToPublicLiveQueueRoom,
    emitDoctorSessionUpdate,
};
