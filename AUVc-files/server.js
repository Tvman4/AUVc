const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Room data storage: { roomCode: { socketId: { username, x, y, isDead, inMeeting } } }
const activeRooms = {};

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('join-room', ({ username, room }) => {
        socket.join(room);
        
        if (!activeRooms[room]) {
            activeRooms[room] = {};
        }

        activeRooms[room][socket.id] = {
            username,
            x: 0,
            y: 0,
            isDead: false,
            inMeeting: false
        };

        // Notify room members
        io.to(room).emit('room-update', activeRooms[room]);

        // WebRTC Signaling: Forward offer
        socket.on('offer', ({ targetId, offer }) => {
            socket.to(targetId).emit('offer', { senderId: socket.id, offer });
        });

        // WebRTC Signaling: Forward answer
        socket.on('answer', ({ targetId, answer }) => {
            socket.to(targetId).emit('answer', { senderId: socket.id, answer });
        });

        // WebRTC Signaling: Forward ICE candidates
        socket.on('ice-candidate', ({ targetId, candidate }) => {
            socket.to(targetId).emit('ice-candidate', { senderId: socket.id, candidate });
        });

        // Listen for player coordinate/state updates (from a host hook or input source)
        socket.on('update-state', (data) => {
            if (activeRooms[room] && activeRooms[room][socket.id]) {
                activeRooms[room][socket.id].x = data.x;
                activeRooms[room][socket.id].y = data.y;
                activeRooms[room][socket.id].isDead = data.isDead;
                activeRooms[room][socket.id].inMeeting = data.inMeeting;

                // Broadcast updated positions back to the room
                io.to(room).emit('room-update', activeRooms[room]);
            }
        });

        socket.on('disconnect', () => {
            if (activeRooms[room] && activeRooms[room][socket.id]) {
                delete activeRooms[room][socket.id];
                if (Object.keys(activeRooms[room]).length === 0) {
                    delete activeRooms[room];
                } else {
                    io.to(room).emit('room-update', activeRooms[room]);
                }
            }
            console.log(`User disconnected: ${socket.id}`);
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`AUVc Server is running on port ${PORT}`);
});
